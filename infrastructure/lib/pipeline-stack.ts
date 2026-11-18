import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CONFIG } from './config';

export interface PipelineStackProps extends StackProps {
  webRepo: ecr.IRepository;
  workerRepo: ecr.IRepository;
  webService: ecs.IBaseService;
  workerService: ecs.IBaseService;
  connectionArn: string;
  owner?: string;
  repo?: string;
  branch?: string;
}

/** GitHub -> CodeBuild (test, build both images, push to ECR) -> two ECS rolling deployments. */
export class PipelineStack extends Stack {
  readonly pipeline: codepipeline.Pipeline;
  readonly project: codebuild.PipelineProject;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const artifacts = new s3.Bucket(this, 'Artifacts', {
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(14) }],
    });

    this.project = new codebuild.PipelineProject(this, 'Build', {
      projectName: `${CONFIG.project}-build`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(CONFIG.buildspecPath),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // Docker daemon
      },
      environmentVariables: {
        WEB_REPO_URI: { value: props.webRepo.repositoryUri },
        WORKER_REPO_URI: { value: props.workerRepo.repositoryUri },
        WEB_CONTAINER: { value: CONFIG.containers.web },
        WORKER_CONTAINER: { value: CONFIG.containers.worker },
      },
      logging: {
        cloudWatch: { logGroup: new logs.LogGroup(this, 'BuildLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }) },
      },
      timeout: Duration.minutes(20),
    });
    props.webRepo.grantPullPush(this.project);
    props.workerRepo.grantPullPush(this.project);

    const source = new codepipeline.Artifact('Source');
    const built = new codepipeline.Artifact('Built');

    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${CONFIG.project}-delivery`,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket: artifacts,
      restartExecutionOnUpdate: false,
    });
    this.pipeline.addStage({
      stageName: 'Source',
      actions: [new actions.CodeStarConnectionsSourceAction({
        actionName: 'GitHub',
        owner: props.owner ?? CONFIG.github.owner,
        repo: props.repo ?? CONFIG.github.repo,
        branch: props.branch ?? CONFIG.github.branch,
        connectionArn: props.connectionArn,
        output: source,
        triggerOnPush: true,
      })],
    });
    this.pipeline.addStage({
      stageName: 'Build',
      actions: [new actions.CodeBuildAction({
        actionName: 'TestAndBuildImages', project: this.project, input: source, outputs: [built],
      })],
    });
    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new actions.EcsDeployAction({
          actionName: 'DeployWeb', service: props.webService,
          imageFile: built.atPath(CONFIG.imageDefinitionFiles.web),
          deploymentTimeout: Duration.minutes(15),
        }),
        new actions.EcsDeployAction({
          actionName: 'DeployWorker', service: props.workerService,
          imageFile: built.atPath(CONFIG.imageDefinitionFiles.worker),
          deploymentTimeout: Duration.minutes(15),
        }),
      ],
    });
  }
}
