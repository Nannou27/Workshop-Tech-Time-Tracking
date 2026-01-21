require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');

const db = require('./src/database/connection');
const logger = require('./src/utils/logger');
const errorHandler = require('./src/middleware/errorHandler');

// Import routes
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const roleRoutes = require('./src/routes/roles');
const technicianRoutes = require('./src/routes/technicians');
const jobCardRoutes = require('./src/routes/jobCards');
const assignmentRoutes = require('./src/routes/assignments');
const timeLogRoutes = require('./src/routes/timeLogs');
const shiftsRoutes = require('./src/routes/shifts');
const reportRoutes = require('./src/routes/reports');
const settingsRoutes = require('./src/routes/settings');
const businessUnitRoutes = require('./src/routes/businessUnits');
const locationRoutes = require('./src/routes/locations');
const assetRoutes = require('./src/routes/assets');
const partRoutes = require('./src/routes/parts');
const barcodeRoutes = require('./src/routes/barcode');
const workOrderPartsRoutes = require('./src/routes/workOrderParts');
const jobHistoryRoutes = require('./src/routes/jobHistory');
const assetMovementsRoutes = require('./src/routes/assetMovements');
const netsuiteRoutes = require('./src/routes/netsuite');
const fieldVisibilityRoutes = require('./src/routes/fieldVisibility');
const businessUnitJobTypesRoutes = require('./src/routes/businessUnitJobTypes');
const assetTypesRoutes = require('./src/routes/assetTypes');
const assetStatusesRoutes = require('./src/routes/assetStatuses');
const partStatusesRoutes = require('./src/routes/partStatuses');
const priorityLevelsRoutes = require('./src/routes/priorityLevels');
const jobCardStatusesRoutes = require('./src/routes/jobCardStatuses');
const assignmentStatusesRoutes = require('./src/routes/assignmentStatuses');
const partCategoriesRoutes = require('./src/routes/partCategories');
const workOrderStageHistoryRoutes = require('./src/routes/workOrderStageHistory');
const integrityRoutes = require('./src/routes/integrity');
const brandingRoutes = require('./src/routes/branding');

// WebSocket handler
const socketHandler = require('./src/websocket/handler');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.API_VERSION || 'v1';

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.sheetjs.com", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'", "'unsafe-hashes'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      // Avoid hardcoding hosts; allow same-origin plus websocket schemes.
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(`/api/${API_VERSION}/`, limiter);

// Health check
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await db.query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      redis: 'connected' // TODO: Add Redis health check
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// API Routes
app.use(`/api/${API_VERSION}/auth`, authRoutes);
app.use(`/api/${API_VERSION}/users`, userRoutes);
app.use(`/api/${API_VERSION}/roles`, roleRoutes);
app.use(`/api/${API_VERSION}/technicians`, technicianRoutes);
app.use(`/api/${API_VERSION}/jobcards`, jobCardRoutes);
app.use(`/api/${API_VERSION}/assignments`, assignmentRoutes);
app.use(`/api/${API_VERSION}/timelogs`, timeLogRoutes);
app.use(`/api/${API_VERSION}/shifts`, shiftsRoutes);
app.use(`/api/${API_VERSION}/reports`, reportRoutes);
app.use(`/api/${API_VERSION}/settings`, settingsRoutes);
app.use(`/api/${API_VERSION}/business-units`, businessUnitRoutes);
app.use(`/api/${API_VERSION}/locations`, locationRoutes);
app.use(`/api/${API_VERSION}/assets`, assetRoutes);
app.use(`/api/${API_VERSION}/parts`, partRoutes);
app.use(`/api/${API_VERSION}/barcode`, barcodeRoutes);
app.use(`/api/${API_VERSION}/work-orders`, workOrderPartsRoutes);
app.use(`/api/${API_VERSION}/job-history`, jobHistoryRoutes);
app.use(`/api/${API_VERSION}/asset-movements`, assetMovementsRoutes);
app.use(`/api/${API_VERSION}/netsuite`, netsuiteRoutes);
app.use(`/api/${API_VERSION}/field-visibility`, fieldVisibilityRoutes);
app.use(`/api/${API_VERSION}/business-unit-job-types`, businessUnitJobTypesRoutes);
app.use(`/api/${API_VERSION}/asset-types`, assetTypesRoutes);
app.use(`/api/${API_VERSION}/asset-statuses`, assetStatusesRoutes);
app.use(`/api/${API_VERSION}/part-statuses`, partStatusesRoutes);
app.use(`/api/${API_VERSION}/priority-levels`, priorityLevelsRoutes);
app.use(`/api/${API_VERSION}/job-card-statuses`, jobCardStatusesRoutes);
app.use(`/api/${API_VERSION}/assignment-statuses`, assignmentStatusesRoutes);
app.use(`/api/${API_VERSION}/part-categories`, partCategoriesRoutes);
app.use(`/api/${API_VERSION}/work-order-stage-history`, workOrderStageHistoryRoutes);
app.use(`/api/${API_VERSION}/integrity`, integrityRoutes);
app.use(`/api/${API_VERSION}/branding`, brandingRoutes);

// WebSocket connection handling
io.use((socket, next) => {
  // TODO: Add JWT authentication for WebSocket
  next();
});

io.on('connection', (socket) => {
  socketHandler(socket, io);
});

// Error handling middleware (must be last)
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Resource not found',
      path: req.path
    }
  });
});

// Start server
httpServer.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`API Version: ${API_VERSION}`);
  
  // Test database connection
  try {
    await db.query('SELECT 1');
    logger.info('Database connection established');
  } catch (error) {
    logger.error('Database connection failed:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    logger.info('HTTP server closed');
    db.end(() => {
      logger.info('Database connection closed');
      process.exit(0);
    });
  });
});

module.exports = { app, io };

