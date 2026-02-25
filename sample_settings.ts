import Settings from './src/settings';

export default {
  gitlab: {
    // url: 'https://gitlab.mycompany.com',
    token: '{{gitlab private token}}',
    projectId: 0,
    listArchivedProjects: true,
    sessionCookie: "",
  },
  github: {
    // baseUrl: 'https://github.mycompany.com:123/etc',
    // apiUrl: 'https://api.github.mycompany.com',
    owner: '{{repository owner (user or organization)}}',
    ownerIsOrg: false,
    token: '{{token}}',
    token_owner: '{{token_owner}}',
    repo: '{{repo}}',
    recreateRepo: false,
  },
  s3: {
    accessKeyId: '{{accessKeyId}}',
    secretAccessKey: '{{secretAccessKey}}',
    bucket: 'my-gitlab-bucket',
    region: 'us-west-1',
  },
  // Optional: Use a public GitHub wiki to host migrated images
  // This is useful for private repositories where S3 may not be desired
  // The wiki must belong to a PUBLIC repository and be initialized (create Home page first)
  // To disable, comment out this section or set to undefined
  // If proxy, wiki, and s3 are configured, priority is: proxy > wiki > s3
  /*
  wiki: {
    owner: '{{GitHub owner}}',
    repo: '{{public repo name}}', // Must be a PUBLIC repository
    imagesPath: 'images', // Directory path within wiki repo for storing images
  },
  */
  // Optional: Use Azure Functions proxy for truly private image hosting
  // This serves images from a private GitHub repository through a proxy endpoint
  // Requires: Azure Function deployed, private asset repo created, GitHub PAT
  // Priority: If configured, takes precedence over wiki and S3
  /*
  proxy: {
    assetRepo: '{{owner/gitlab-migrated-assets}}', // Private GitHub repo (format: owner/repo)
    assetRepoToken: '{{GitHub PAT with repo access}}', // GitHub Personal Access Token
    azureFunctionUrl: 'https://{{your-function-app}}.azurewebsites.net/api/getImage',
  },
  */
  usermap: {
    'username.gitlab.1': 'username.github.1',
    'username.gitlab.2': 'username.github.2',
  },
  projectmap: {
    'gitlabgroup/projectname.1': 'GitHubOrg/projectname.1',
    'gitlabgroup/projectname.2': 'GitHubOrg/projectname.2',
  },
  conversion: {
    useLowerCaseLabels: true,
    addIssueInformation: true,
  },
  transfer: {
    description: true,
    milestones: true,
    labels: true,
    issues: true,
    mergeRequests: true,
    releases: true,
  },
  dryRun: false,
  exportUsers: false,
  useIssueImportAPI: true,
  usePlaceholderMilestonesForMissingMilestones: true,
  usePlaceholderIssuesForMissingIssues: true,
  useReplacementIssuesForCreationFails: true,
  useIssuesForAllMergeRequests: false,
  filterByLabel: undefined,
  trimOversizedLabelDescriptions: false,
  skipMergeRequestStates: [],
  skipMatchingComments: [],
  mergeRequests: {
    logFile: './merge-requests.json',
    log: false,
  },
} as Settings;
