#!/bin/bash
aws ecs register-task-definition \
  --family ai-recruiter-interview \
  --task-role-arn arn:aws:iam::090605004529:role/ecsTaskExecutionRole \
  --execution-role-arn arn:aws:iam::090605004529:role/ecsTaskExecutionRole \
  --network-mode awsvpc \
  --requires-compatibilities FARGATE \
  --cpu 256 \
  --memory 512 \
  --container-definitions '[
    {
      "name": "ai-recruiter-backend",
      "image": "090605004529.dkr.ecr.eu-central-1.amazonaws.com/ai-recruiter-backend:latest",
      "portMappings": [
        {
          "containerPort": 8080,
          "hostPort": 8080,
          "protocol": "tcp"
        }
      ],
      "essential": true,
      "environment": [
        {
          "name": "USE_HTTPS",
          "value": "true"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/ai-recruiter-interview",
          "awslogs-region": "eu-central-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]' \
  --region eu-central-1
