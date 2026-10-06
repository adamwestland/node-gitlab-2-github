const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { S3Client } = require('@aws-sdk/client-s3');
const { Octokit } = require('@octokit/rest');
const { throttling } = require('@octokit/plugin-throttling');
// Never load a user's real settings while testing.
const settingsPath = require.resolve('../settings');
require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: require('../sample_settings') };
const { migrateAttachments } = require('../src/utils');
const { GitlabHelper } = require('../src/gitlabHelper');

const s3 = { bucket: 'test-bucket', region: 'us-west-1', accessKeyId: 'test', secretAccessKey: 'test' };
const url = '/uploads/abc/photo.png';
const markdown = `![photo](${url})`;
const key = createHash('sha256').update(url).digest('hex') + '/photo.png';
const gitlab = { host: 'https://gitlab.example', projectPath: 'group/project', getAttachment: async () => Buffer.from('image') };

test('S3 v3 upload is awaited and preserves bucket, credentials, content type and stable key', async t => {
  const requests = [];
  let completed = false;
  t.mock.method(S3Client.prototype, 'send', async function(command) {
    requests.push(command);
    assert.equal(await this.config.region(), 'us-west-1');
    assert.equal((await this.config.credentials()).accessKeyId, 'test');
    await new Promise(resolve => setImmediate(resolve));
    completed = true;
    return { ETag: 'test-etag' };
  });
  const result = await migrateAttachments(markdown, 42, s3, gitlab);
  assert.equal(completed, true);
  assert.equal(requests[0].constructor.name, 'PutObjectCommand');
  assert.equal(requests[0].input.Key, `42/${key}`);
  assert.equal(requests[0].input.Bucket, s3.bucket);
  assert.equal(requests[0].input.ContentType, 'image/png');
  assert.equal(result, `![photo](https://s3.us-west-1.amazonaws.com/test-bucket/42/${key})`);
});

test('large attachments retain multipart upload support', async t => {
  const commands = [];
  t.mock.method(S3Client.prototype, 'send', async command => {
    commands.push(command);
    return { UploadId: 'test-upload', ETag: 'part-etag' };
  });
  const result = await migrateAttachments(markdown, undefined, s3, {
    ...gitlab, getAttachment: async () => Buffer.alloc(6 * 1024 * 1024),
  });
  assert.ok(commands.some(c => c.constructor.name === 'CreateMultipartUploadCommand'));
  assert.equal(commands.filter(c => c.constructor.name === 'UploadPartCommand').length, 2);
  assert.ok(commands.some(c => c.constructor.name === 'CompleteMultipartUploadCommand'));
  assert.ok(result.endsWith(`/${key})`));
});

test('failed upload propagates instead of publishing a broken replacement link', async t => {
  t.mock.method(S3Client.prototype, 'send', async () => { throw new Error('upload failed'); });
  await assert.rejects(migrateAttachments(markdown, 42, s3, gitlab), /upload failed/);
});

test('unavailable attachment retains original markdown', async () => {
  assert.equal(await migrateAttachments(markdown, 42, s3, {
    ...gitlab, getAttachment: async () => undefined,
  }), markdown);
});

test('non-S3 mode preserves attachment label and uses the GitLab project URL', async () => {
  assert.equal(await migrateAttachments(markdown, 42, undefined, gitlab),
    '![photo](https://gitlab.example/group/project/uploads/abc/photo.png)');
});

test('Octokit REST and throttling interoperate with CommonJS on supported Node', async () => {
  const Api = Octokit.plugin(throttling);
  let requestUrl;
  const api = new Api({
    auth: 'test-token',
    throttle: { enabled: false },
    request: { fetch: async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({ id: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
    } },
  });
  const response = await api.repos.get({ owner: 'example', repo: 'test' });
  assert.equal(response.data.id, 42);
  assert.equal(requestUrl, 'https://api.github.com/repos/example/test');
});

test('GitLab helper preserves project path and handles the archived option', async () => {
  let params;
  const api = { Projects: {
    show: async () => ({ path_with_namespace: 'group/project' }),
    all: async options => { params = options; return []; },
  } };
  const helper = new GitlabHelper(api, { url: 'https://gitlab.example/', token: 'test', projectId: 42, listArchivedProjects: false, sessionCookie: '' });
  await helper.registerProjectPath(42);
  assert.equal(helper.projectPath, 'group/project');
  assert.equal(helper.host, 'https://gitlab.example');
  await helper.listProjects();
  assert.deepEqual(params, { membership: true, archived: false });
});

test('CLI loads upgraded dependencies and refuses sample credentials before migration', () => {
  const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', "const id = require.resolve('./settings'); require.cache[id] = { id, filename: id, loaded: true, exports: require('./sample_settings') }; require('./src/index');"], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /enter your GitLab private token/);
  assert.doesNotMatch(result.stderr, /ERR_REQUIRE_ESM|TSError|Cannot find module/);
});
