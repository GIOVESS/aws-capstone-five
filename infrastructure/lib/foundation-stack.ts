import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { CONFIG } from './config';

/** ECR repositories. Deployed first so the bootstrap images can be pushed before ECS needs them. */
export class FoundationStack extends Stack {
  readonly webRepo: ecr.Repository;
  readonly workerRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const repo = (name: string, logical: string) =>
      new ecr.Repository(this, logical, {
        repositoryName: name,
        imageScanOnPush: true,
        removalPolicy: RemovalPolicy.DESTROY,
        emptyOnDelete: true,
        lifecycleRules: [{ maxImageCount: 15, description: 'keep the 15 newest images' }],
      });
    this.webRepo = repo(CONFIG.repos.web, 'WebRepo');
    this.workerRepo = repo(CONFIG.repos.worker, 'WorkerRepo');
  }
}
