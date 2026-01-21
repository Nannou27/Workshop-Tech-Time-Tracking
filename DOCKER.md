# Docker Deployment Guide

This guide covers deploying the Workshop Technician Time Tracking (WTTT) application using Docker with AWS RDS (PostgreSQL) and AWS ElastiCache (Redis).

## Prerequisites

- Docker and Docker Compose installed
- AWS RDS PostgreSQL instance
- AWS ElastiCache Redis cluster
- Network access from your Docker host to AWS services

## Files Overview

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build for the Node.js application |
| `docker-compose.yml` | Container orchestration configuration |
| `.dockerignore` | Files excluded from Docker build context |
| `.env` | Environment variables (local development) |
| `.env.example` | Template for environment variables |

## Quick Start

### 1. Configure Environment Variables

Copy the example environment file and update with your values:

```bash
cp .env.example .env
```

Edit `.env` with your AWS credentials:

```env
# AWS RDS PostgreSQL
DB_HOST=your-rds-instance.region.rds.amazonaws.com
DB_PORT=5432
DB_NAME=wttt
DB_USER=postgres
DB_PASSWORD=your-secure-password

# AWS ElastiCache Redis
REDIS_HOST=your-elasticache-cluster.region.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_TLS=true
REDIS_DB=0

# Application Security
JWT_SECRET=your-secure-jwt-secret-min-32-chars

# CORS
CORS_ORIGIN=https://yourdomain.com

# Logging
LOG_LEVEL=info
```

### 2. Build and Run

```bash
# Build and start the container
docker-compose up -d --build

# View logs
docker-compose logs -f app

# Stop the container
docker-compose down
```

### 3. Verify Deployment

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

## Environment Variables Reference

### Database (AWS RDS PostgreSQL)

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_HOST` | RDS endpoint hostname | `localhost` |
| `DB_PORT` | Database port | `5432` |
| `DB_NAME` | Database name | `wttt` |
| `DB_USER` | Database username | `postgres` |
| `DB_PASSWORD` | Database password | - |
| `DB_SSL` | Enable SSL connection | `true` (in Docker) |

### Cache (AWS ElastiCache Redis)

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_HOST` | ElastiCache endpoint hostname | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis AUTH password (if enabled) | - |
| `REDIS_TLS` | Enable TLS for ElastiCache | `false` |
| `REDIS_DB` | Redis database index (0-15) | `0` |

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Application port | `3000` |
| `JWT_SECRET` | Secret for JWT token signing | - |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |

## Local Development

For local development without AWS services, run PostgreSQL and Redis locally:

```bash
# Start local PostgreSQL
docker run -d \
  --name postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=wttt \
  -p 5432:5432 \
  postgres:15-alpine

# Start local Redis
docker run -d \
  --name redis \
  -p 6379:6379 \
  redis:7-alpine

# Initialize the database schema
psql -h localhost -U postgres -d wttt -f schema.sql
```

Then use the default `.env` configuration which points to `localhost`.

## AWS Configuration

### RDS PostgreSQL Setup

1. Create an RDS PostgreSQL 15+ instance
2. Configure security group to allow inbound traffic on port 5432 from your Docker host
3. Note the endpoint URL from the RDS console
4. Create the database and run the schema:

```bash
psql -h your-rds-endpoint.region.rds.amazonaws.com -U postgres -d wttt -f schema.sql
```

### ElastiCache Redis Setup

1. Create an ElastiCache Redis 7+ cluster
2. Enable encryption in-transit (TLS) for production
3. Configure security group to allow inbound traffic on port 6379
4. Note the primary endpoint URL
5. Set `REDIS_TLS=true` in your `.env` file

### Security Group Configuration

Ensure your security groups allow:

| Service | Port | Source |
|---------|------|--------|
| RDS PostgreSQL | 5432 | Docker host IP/VPC |
| ElastiCache Redis | 6379 | Docker host IP/VPC |

## Docker Commands Reference

```bash
# Build the image
docker-compose build

# Start in detached mode
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop containers
docker-compose down

# Rebuild and restart
docker-compose up -d --build

# Shell into running container
docker exec -it wttt-app sh

# Check container health
docker inspect --format='{{.State.Health.Status}}' wttt-app
```

## Troubleshooting

### Cannot connect to RDS

1. Verify security group allows inbound from Docker host
2. Check `DB_SSL=true` is set for RDS connections
3. Verify RDS instance is publicly accessible (if connecting from outside VPC)

### Cannot connect to ElastiCache

1. ElastiCache is VPC-only; ensure Docker host is in the same VPC
2. Verify `REDIS_TLS=true` if encryption in-transit is enabled
3. Check security group rules

### Container health check failing

1. Check application logs: `docker-compose logs app`
2. Verify database connection is successful
3. Ensure `/health` endpoint is accessible

### Application not starting

1. Check all required environment variables are set
2. Verify database schema is initialized
3. Review logs for specific error messages

## Production Recommendations

1. **Use AWS Secrets Manager** for sensitive values instead of `.env` files
2. **Enable RDS encryption** at rest and in transit
3. **Use private subnets** for RDS and ElastiCache
4. **Set up CloudWatch alarms** for monitoring
5. **Configure auto-scaling** for the application containers
6. **Use a load balancer** (ALB/NLB) in front of containers
7. **Implement proper backup strategies** for RDS
