import { S3Settings, WikiSettings, ProxySettings } from './settings';
import settings from '../settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';
import * as fs from 'fs';
import { execSync } from 'child_process';
import axios from 'axios';
import simpleGit from 'simple-git';

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

// Wiki helper - tracks if wiki has been cloned
let wikiCloned = false;
let wikiPath: string | null = null;

// Clones wiki repo if not already cloned
const ensureWikiCloned = (wiki: WikiSettings) => {
  if (wikiCloned && wikiPath) {
    return wikiPath;
  }

  wikiPath = path.join(process.cwd(), '.wiki-temp');
  const wikiUrl = `https://github.com/${wiki.owner}/${wiki.repo}.wiki.git`;

  try {
    if (fs.existsSync(wikiPath)) {
      console.log(`Wiki already cloned at ${wikiPath}, pulling latest...`);
      execSync('git pull', { cwd: wikiPath, stdio: 'inherit' });
    } else {
      console.log(`Cloning wiki from ${wikiUrl}...`);
      execSync(`git clone ${wikiUrl} ${wikiPath}`, { stdio: 'inherit' });
    }
    wikiCloned = true;
    return wikiPath;
  } catch (err) {
    console.error(`Error cloning/updating wiki:`, err);
    throw err;
  }
};

// Uploads an image to the wiki and returns the public URL
const uploadToWiki = (
  buffer: Buffer,
  filename: string,
  wiki: WikiSettings
): string => {
  const wikiDir = ensureWikiCloned(wiki);
  const imagesDir = path.join(wikiDir, wiki.imagesPath);

  // Create images directory if it doesn't exist
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  // Generate unique filename using hash to avoid collisions
  const hash = crypto.createHash('sha256');
  hash.update(filename + Date.now());
  const uniqueFilename = hash.digest('hex').substring(0, 16) + '-' + filename;
  const filePath = path.join(imagesDir, uniqueFilename);

  // Write image to wiki repo
  fs.writeFileSync(filePath, buffer);

  // Commit and push
  try {
    execSync(`git add "${wiki.imagesPath}/${uniqueFilename}"`, { cwd: wikiDir });
    execSync(`git commit -m "Add migrated image: ${uniqueFilename}"`, { cwd: wikiDir });
    execSync('git push', { cwd: wikiDir });
  } catch (err) {
    console.error(`Error committing/pushing image ${uniqueFilename}:`, err);
    throw err;
  }

  // Return the public raw.githubusercontent URL
  return `https://raw.githubusercontent.com/wiki/${wiki.owner}/${wiki.repo}/${wiki.imagesPath}/${uniqueFilename}`;
};

// Asset repo helper - tracks if asset repo has been cloned
let assetRepoCloned = false;
let assetRepoPath: string | null = null;

// Clones asset repo if not already cloned
const ensureAssetRepoCloned = async (proxy: ProxySettings) => {
  if (assetRepoCloned && assetRepoPath) {
    return assetRepoPath;
  }

  assetRepoPath = path.join(process.cwd(), '.asset-repo-temp');
  const [owner, repo] = proxy.assetRepo.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid assetRepo format: ${proxy.assetRepo}. Expected: owner/repo`);
  }

  // Use HTTPS with token authentication
  const repoUrl = `https://${proxy.assetRepoToken}@github.com/${owner}/${repo}.git`;

  const git = simpleGit();

  try {
    if (fs.existsSync(assetRepoPath)) {
      console.log(`Asset repo already cloned at ${assetRepoPath}, pulling latest...`);
      await git.cwd(assetRepoPath).pull();
    } else {
      console.log(`Cloning asset repo: ${owner}/${repo}...`);
      await git.clone(repoUrl, assetRepoPath);
    }
    // Set bot identity for asset repo commits (avoids inflating personal contribution graphs)
    const assetGit = simpleGit(assetRepoPath);
    await assetGit.addConfig('user.name', 'GitLab Migration Bot');
    await assetGit.addConfig('user.email', 'gitlab-migration-bot@noreply.greatbuildersolutions.com');

    assetRepoCloned = true;
    return assetRepoPath;
  } catch (err) {
    console.error(`Error cloning/updating asset repo:`, err);
    throw err;
  }
};

// Uploads an image to the asset repo and returns the Azure Function URL
const uploadToAssetRepo = async (
  buffer: Buffer,
  filename: string,
  proxy: ProxySettings,
  repoName: string
): Promise<string> => {
  const repoDir = await ensureAssetRepoCloned(proxy);
  const imagesDir = path.join(repoDir, 'images', repoName);

  // Create images directory if it doesn't exist
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  // Generate unique filename using hash to avoid collisions
  const hash = crypto.createHash('sha256');
  hash.update(filename + Date.now());
  const uniqueFilename = hash.digest('hex').substring(0, 16) + '-' + filename;
  const filePath = path.join(imagesDir, uniqueFilename);

  // Write image to asset repo
  fs.writeFileSync(filePath, buffer);

  // Commit and push
  try {
    const git = simpleGit(repoDir);
    await git.add(`images/${repoName}/${uniqueFilename}`);
    await git.commit(`Add migrated image: ${repoName}/${uniqueFilename}`);
    await git.push();
  } catch (err) {
    console.error(`Error committing/pushing image ${uniqueFilename}:`, err);
    throw err;
  }

  // Return the Azure Function URL
  return `${proxy.azureFunctionUrl}?file=${repoName}/${uniqueFilename}`;
};

// Creates new attachments and replaces old links
export const migrateAttachments = async (
  body: string,
  githubRepoId: number | undefined,
  s3: S3Settings | undefined,
  gitlabHelper: GitlabHelper,
  wiki?: WikiSettings,
  proxy?: ProxySettings,
  repoName?: string
) => {
  // Match both relative (/uploads/...) and absolute (https://...gitlab.../uploads/...) URLs
  const relativeRegexp = /(!?)\[([^\]]+)\]\((\/uploads[^)]+)\)/g;
  const absoluteRegexp = /(!?)\[([^\]]+)\]\((https?:\/\/[^\/]+\/.*?\/uploads\/[^)]+)\)/g;

  // Maps link offset to a new URL
  const offsetToAttachment: { [key: number]: string } = {};

  // Helper function to process a single image URL
  const processImageUrl = async (
    prefix: string,
    name: string,
    url: string,
    isAbsolute: boolean,
    matchIndex: number
  ) => {
    try {
      const basename = path.basename(url.split('?')[0]); // Remove query params
      let attachmentBuffer: Buffer | null = null;

      // Download the image
      if (isAbsolute) {
        console.log(`\tDownloading absolute URL: ${url}`);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        attachmentBuffer = Buffer.from(response.data, 'binary');
      } else {
        console.log(`\tDownloading relative URL: ${url}`);
        attachmentBuffer = await gitlabHelper.getAttachment(url);
      }

      if (!attachmentBuffer) {
        console.error(`\tFailed to download: ${url}`);
        return;
      }

      // Upload priority: proxy > wiki > S3
      let newUrl: string;

      if (proxy && proxy.assetRepo && proxy.azureFunctionUrl) {
        console.log(`\tUploading ${basename} to asset repo (proxy)...`);
        newUrl = await uploadToAssetRepo(attachmentBuffer, basename, proxy, repoName || 'default');
        console.log(`\t...Uploaded, proxy URL: ${newUrl}`);
      } else if (wiki && wiki.owner && wiki.repo) {
        console.log(`\tUploading ${basename} to wiki...`);
        newUrl = uploadToWiki(attachmentBuffer, basename, wiki);
        console.log(`\t...Uploaded to wiki: ${newUrl}`);
      } else if (s3 && s3.bucket) {
        console.log(`\tUploading ${basename} to S3...`);
        const mimeType = mime.lookup(basename);
        const hash = crypto.createHash('sha256');
        hash.update(url);
        const newFileName = hash.digest('hex') + '/' + basename;
        const relativePath = githubRepoId
          ? `${githubRepoId}/${newFileName}`
          : newFileName;

        let hostname = `${s3.bucket}.s3.amazonaws.com`;
        if (s3.region) {
          hostname = `s3.${s3.region}.amazonaws.com/${s3.bucket}`;
        }
        newUrl = `https://${hostname}/${relativePath}`;

        const s3bucket = new S3();
        const params: S3.PutObjectRequest = {
          Key: relativePath,
          Body: attachmentBuffer,
          ContentType: mimeType === false ? undefined : mimeType,
          Bucket: s3.bucket,
          ACL: 'public-read', // Make images publicly accessible
        };

        await new Promise((resolve, reject) => {
          s3bucket.upload(params, function (err, data) {
            if (err) {
              console.error(`\tERROR uploading to S3:`, err);
              reject(err);
            } else {
              console.log(`\t...Done uploading to S3`);
              resolve(data);
            }
          });
        });
      } else {
        // No wiki or S3: keep original URL (will be broken for absolute URLs)
        const host = gitlabHelper.host.endsWith('/')
          ? gitlabHelper.host
          : gitlabHelper.host + '/';
        newUrl = isAbsolute ? url : host + gitlabHelper.projectPath + url;
        console.log(`\tNo wiki or S3 configured, keeping original URL: ${newUrl}`);
      }

      offsetToAttachment[matchIndex] = `${prefix}[${name}](${newUrl})`;
    } catch (error) {
      console.error(`\tError processing image ${url}:`, error);
    }
  };

  // Collect all matches (both relative and absolute)
  const allMatches: Array<{
    prefix: string;
    name: string;
    url: string;
    isAbsolute: boolean;
    index: number;
  }> = [];

  // Find relative matches
  for (const match of body.matchAll(relativeRegexp)) {
    allMatches.push({
      prefix: match[1] || '',
      name: match[2],
      url: match[3],
      isAbsolute: false,
      index: match.index as number,
    });
  }

  // Find absolute matches
  for (const match of body.matchAll(absoluteRegexp)) {
    allMatches.push({
      prefix: match[1] || '',
      name: match[2],
      url: match[3],
      isAbsolute: true,
      index: match.index as number,
    });
  }

  // Process all matches
  for (const match of allMatches) {
    await processImageUrl(
      match.prefix,
      match.name,
      match.url,
      match.isAbsolute,
      match.index
    );
  }

  // Replace all URLs in the body
  let result = body;

  // Replace relative URLs (3 capture groups: prefix, name, url)
  result = result.replace(
    relativeRegexp,
    function(_match: string, _p1: string, _p2: string, _p3: string, offset: number) { return offsetToAttachment[offset] || _match; }
  );

  // Replace absolute URLs (3 capture groups: prefix, name, url)
  result = result.replace(
    absoluteRegexp,
    function(_match: string, _p1: string, _p2: string, _p3: string, offset: number) { return offsetToAttachment[offset] || _match; }
  );

  return result;
};

export const organizationUsersString = (users: string[], prefix: string): string => {
  let organizationUsers = [];
  for (let assignee of users) {
    let githubUser = settings.usermap[assignee as string];
    if (githubUser) {
      githubUser = '@' + githubUser;
    } else {
      githubUser = assignee as string;
    }
    organizationUsers.push(githubUser);
  }

  if (organizationUsers.length > 0) {
    return `\n\n**${prefix}:** ` + organizationUsers.join(', ');
  }

  return '';
}
