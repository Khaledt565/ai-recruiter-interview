#!/bin/bash
# Build and push Docker image to ECR

set -e

# Configuration
AWS_ACCOUNT_ID="090605004529"
AWS_REGION="eu-central-1"
ECR_REPO_NAME="ai-recruiter-backend"
IMAGE_TAG="${1:-latest}"

# Construct full image URI
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "🔨 Building Docker image..."
docker build -t ${ECR_URI}:${IMAGE_TAG} backend/

echo "🔑 Logging in to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

echo "📤 Pushing image to ECR..."
docker push ${ECR_URI}:${IMAGE_TAG}

# Also push with 'latest' tag if not already doing so
if [ "${IMAGE_TAG}" != "latest" ]; then
  docker tag ${ECR_URI}:${IMAGE_TAG} ${ECR_URI}:latest
  docker push ${ECR_URI}:latest
fi

echo "✅ Successfully pushed: ${ECR_URI}:${IMAGE_TAG}"
echo "📝 Update your Fargate task definition to use this image"
