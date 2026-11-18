#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { CONFIG } from '../lib/config';
import { FoundationStack } from '../lib/foundation-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { PlatformStack } from '../lib/platform-stack';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See README step "Set environment variables".`);
  return v;
}

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: CONFIG.region };

const foundation = new FoundationStack(app, 'Cap5Foundation', { env });
const platform = new PlatformStack(app, 'Cap5Platform', {
  env,
  webRepo: foundation.webRepo,
  workerRepo: foundation.workerRepo,
  zoneName: required('ZONE_NAME'),
  alertEmail: required('ALERT_EMAIL'),
  imageTag: process.env.IMAGE_TAG,
});

// The pipeline needs an AVAILABLE GitHub connection, so it is only added once CONNECTION_ARN is exported.
if (process.env.CONNECTION_ARN) {
  new PipelineStack(app, 'Cap5Pipeline', {
    env,
    webRepo: foundation.webRepo,
    workerRepo: foundation.workerRepo,
    webService: platform.compute.webService,
    workerService: platform.compute.workerService,
    connectionArn: process.env.CONNECTION_ARN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH,
  });
}

Tags.of(app).add('Project', CONFIG.project);
