# Workshop Tech Time Tracking (WTTT) - Setup Guide

## Quick Start on Any New Computer

### Prerequisites
- Node.js (v18+)
- MySQL or PostgreSQL
- Git

### 1. Clone Repository
```bash
git clone https://github.com/Nannou27/Workshop-Tech-Time-Tracking.git
cd Workshop-Tech-Time-Tracking
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Database Setup

**Option A: Local MySQL (XAMPP)**
```bash
# Start XAMPP MySQL
mysql -u root -p
CREATE DATABASE wttt_fresh;
USE wttt_fresh;
source schema_mysql.sql;
```

**Option B: Local PostgreSQL**
```bash
psql -U postgres
CREATE DATABASE wttt_fresh;
\c wttt_fresh
\i schema.sql;
```

**Option C: Use AWS RDS (Recommended)**
Update `.env` with your RDS endpoint - no local database needed!

### 4. Environment Configuration

The `.env` file is already in the repository with demo credentials:
- Database: `wttt_fresh` (local)
- User: `root` (MySQL) or `postgres` (PostgreSQL)
- No password (local development)

**For production or cloud database:**
Edit `.env` to point to your AWS RDS or cloud database.

### 5. Start the Server
```bash
npm start
```

Server runs on: http://localhost:3000

### 6. Default Login Credentials

**Service Advisor:**
- Email: `advisor@wttt.local`
- Password: `BUAdmin!@#`

**Super Admin:**
- Email: `admin@wttt.local` or `superadmin@wttt.local`
- Check database for other accounts

## Project Structure

```
/
├── server.js              # Main server entry point
├── src/
│   ├── routes/           # API endpoints
│   ├── middleware/       # Auth, error handling
│   ├── database/         # Database connection
│   └── utils/            # Helper functions
├── dashboard-*.html      # Frontend dashboards
├── schema*.sql           # Database schemas
└── .env                  # Environment config (demo credentials)
```

## Database Types

- **wttt_fresh** - Non-production/development database (local)
- Multiple SQL schemas available:
  - `schema.sql` - PostgreSQL
  - `schema_mysql.sql` - MySQL
  - Asset management extensions
  - Business unit extensions

## Important Endpoints

- Login: http://localhost:3000
- Service Advisor Dashboard: http://localhost:3000/dashboard-advisor.html
- Super Admin Dashboard: http://localhost:3000/dashboard-super-admin.html
- API Base: http://localhost:3000/api/v1

## Troubleshooting

**Server won't start:**
- Check `.env` file exists
- Verify database connection (DB_HOST, DB_NAME, DB_USER)
- Ensure MySQL/PostgreSQL is running

**Can't login:**
- Check database has users table populated
- Default password for advisor: `BUAdmin!@#`
- Run `/api/v1/auth/demo-accounts` to see all users

**Port 3000 already in use:**
- Kill existing process: `lsof -ti:3000 | xargs kill -9`
- Or change PORT in `.env`

## Deployment

See `DOCKER.md` for AWS deployment with RDS and ElastiCache.

## Need Help?

1. Check this SETUP.md file
2. Review `.env` for configuration
3. Check database connection settings
4. Ensure all SQL schemas are applied

---

**Repository:** https://github.com/Nannou27/Workshop-Tech-Time-Tracking
**Author:** Noha Shekib
**Database:** MySQL/PostgreSQL
**Environment:** Non-Production (Demo Credentials Included)
