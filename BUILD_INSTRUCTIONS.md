# Docker Build & Push Instructions

## Prerequisites
You need Docker installed on a machine (Mac, Linux, or Docker Desktop on Windows)

## Option 1: Build Locally (if you have Docker)

```bash
cd ai-recruiter-interview/
aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin 090605004529.dkr.ecr.eu-central-1.amazonaws.com

docker build -t 090605004529.dkr.ecr.eu-central-1.amazonaws.com/ai-recruiter-backend:https-latest backend/

docker push 090605004529.dkr.ecr.eu-central-1.amazonaws.com/ai-recruiter-backend:https-latest
```

## Option 2: Push via GitHub Actions (requires secrets configured)
- Make sure AWS credentials are in GitHub Secrets:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
- Fix the workflow file for your AWS credentials if needed

## Option 3: Use AWS CodeBuild
```bash
# Create CodeBuild project with buildspec.yml
aws codebuild create-project \
  --name ai-recruiter-backend-build \
  --source type=GITHUB,location=...
```

## After Building

1. Update Fargate task definition with new image URI
2. Force new deployment in ECS
3. Monitor CloudWatch logs for errors

## Current Status
- ✅ Code with HTTPS support: Pushed to main branch
- ✅ Dockerfile ready with certificates: backend/Dockerfile  
- ✅ buildspec.yml created: buildspec.yml
- ⏳ Docker image needs to be built and pushed to ECR
