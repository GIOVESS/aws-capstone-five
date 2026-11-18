/** Single source of truth for names and tunables. Tests import these instead of hard-coding. */
export const CONFIG = {
  project: 'cap5',
  region: 'us-east-1',
  azCount: 2,

  repos: { web: 'cap5-web', worker: 'cap5-worker' },
  containers: { web: 'web', worker: 'worker' },
  imageDefinitionFiles: { web: 'imagedefinitions-web.json', worker: 'imagedefinitions-worker.json' },
  bootstrapTag: 'bootstrap',
  buildspecPath: 'pipeline/buildspec.yml',

  webPort: 8080,
  healthPath: '/health',

  db: { name: 'shop', adminUser: 'shopadmin', port: 5432, backupRetentionDays: 14 },
  cache: { port: 6379, nodeType: 'cache.t4g.micro', engine: 'valkey', engineVersion: '8.0' },

  queue: { visibilitySeconds: 60, maxReceive: 3 },

  web: { cpu: 256, memory: 512, min: 2, max: 6, cpuTarget: 60, requestsPerTarget: 200 },
  worker: { cpu: 256, memory: 512, min: 1, max: 10, queueDepthTarget: 10, threads: 4 },

  dr: { recordLabel: 'shop', healthInterval: 10, healthFailures: 2, backupCron: { minute: '0', hour: '5' } },
  // Hosted zone id of S3 website endpoints in us-east-1 (needed for the Route 53 alias).
  s3WebsiteZoneId: 'Z3AQBSTGFYJSTF',

  github: { owner: 'GIOVESS', repo: 'aws-capstone-five', branch: 'main' },
} as const;

export function recordName(zoneName: string): string {
  return `${CONFIG.dr.recordLabel}.${zoneName}`;
}
