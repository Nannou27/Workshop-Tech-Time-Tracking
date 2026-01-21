const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * NetSuite Integration Service
 * Handles OAuth 1.0 authentication and API calls to NetSuite
 */
class NetSuiteService {
  constructor(config) {
    this.accountId = config.account_id;
    this.consumerKey = config.consumer_key;
    this.consumerSecret = config.consumer_secret;
    this.tokenId = config.token_id;
    this.tokenSecret = config.token_secret;
    this.baseUrl = `https://${this.accountId}.suitetalk.api.netsuite.com`;
    this.realm = this.accountId;
  }

  /**
   * Generate OAuth 1.0 signature
   */
  generateOAuthSignature(method, url, params) {
    // Sort parameters
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');

    // Create signature base string
    const signatureBaseString = [
      method.toUpperCase(),
      encodeURIComponent(url),
      encodeURIComponent(sortedParams)
    ].join('&');

    // Create signing key
    const signingKey = `${encodeURIComponent(this.consumerSecret)}&${encodeURIComponent(this.tokenSecret)}`;

    // Generate signature
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(signatureBaseString)
      .digest('base64');

    return signature;
  }

  /**
   * Generate OAuth 1.0 authorization header
   */
  generateAuthHeaders(method, url, body = null) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const oauthParams = {
      oauth_consumer_key: this.consumerKey,
      oauth_token: this.tokenId,
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: timestamp,
      oauth_nonce: nonce,
      oauth_version: '1.0',
      realm: this.realm
    };

    // Add body hash if present
    if (body) {
      const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64');
      oauthParams.oauth_body_hash = bodyHash;
    }

    // Generate signature
    const signature = this.generateOAuthSignature(method, url, oauthParams);
    oauthParams.oauth_signature = signature;

    // Build authorization header
    const authHeader = 'OAuth ' + Object.keys(oauthParams)
      .sort()
      .map(key => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
      .join(', ');

    return {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'X-NetSuite-Context': this.realm
    };
  }

  /**
   * Test connection to NetSuite
   */
  async testConnection() {
    try {
      const url = `${this.baseUrl}/services/rest/record/v1/metadata-catalog`;
      const headers = this.generateAuthHeaders('GET', url);

      const response = await axios.get(url, {
        headers,
        timeout: 10000
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      logger.error('NetSuite connection test failed:', error);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message || 'Connection failed'
      };
    }
  }

  /**
   * Format time log data for NetSuite
   */
  formatTimeLogPayload(timeLog, fieldMappings = {}) {
    const mappings = {
      job_number: fieldMappings.job_number || 'job_card_no',
      employee_code: fieldMappings.employee_code || 'employee_id',
      hours: fieldMappings.hours || 'hours',
      start_date: fieldMappings.start_date || 'start_date',
      end_date: fieldMappings.end_date || 'end_date',
      notes: fieldMappings.notes || 'memo',
      hourly_rate: fieldMappings.hourly_rate || 'hourly_rate'
    };

    // Calculate hours from duration_seconds
    const hours = timeLog.duration_seconds ? (timeLog.duration_seconds / 3600).toFixed(2) : 0;

    // Format payload for Journal Entry
    const payload = {
      trandate: timeLog.start_ts ? new Date(timeLog.start_ts).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      memo: `WTTT: ${timeLog.job_number || 'N/A'} - ${timeLog.display_name || timeLog.employee_code || 'Technician'}`,
      line: [
        {
          account: mappings.account_id || fieldMappings.account_id, // Labor expense account
          debit: hours * (timeLog.hourly_rate || 0),
          memo: timeLog.notes || `${timeLog.job_number || ''} - ${hours} hours`
        }
      ],
      customFields: {
        [mappings.job_number]: timeLog.job_number,
        [mappings.employee_code]: timeLog.employee_code,
        employee_name: timeLog.display_name,
        start_time: timeLog.start_ts,
        end_time: timeLog.end_ts,
        duration_seconds: timeLog.duration_seconds
      }
    };

    return payload;
  }

  /**
   * Sync entity to NetSuite
   */
  async syncEntity(entityType, entityData, fieldMappings = {}) {
    try {
      let payload;
      let endpoint;

      switch (entityType) {
        case 'time_log':
          payload = this.formatTimeLogPayload(entityData, fieldMappings);
          endpoint = '/services/rest/record/v1/journalEntry';
          break;
        case 'work_order':
          // Format work order payload
          payload = {
            customForm: fieldMappings.custom_form || 'Work Order',
            entity: entityData.customer_id,
            memo: `WTTT Work Order: ${entityData.job_number}`,
            customFields: {
              job_number: entityData.job_number,
              status: entityData.status,
              created_at: entityData.created_at
            }
          };
          endpoint = '/services/rest/record/v1/customrecord_wttt_workorder';
          break;
        default:
          throw new Error(`Unsupported entity type: ${entityType}`);
      }

      const url = `${this.baseUrl}${endpoint}`;
      const headers = this.generateAuthHeaders('POST', url, payload);

      const response = await axios.post(url, payload, {
        headers,
        timeout: 30000
      });

      return {
        success: true,
        netsuiteId: response.data.id || response.data.recordId,
        data: response.data
      };
    } catch (error) {
      logger.error(`NetSuite sync error for ${entityType}:`, error);
      
      const errorMessage = error.response?.data?.error?.message || 
                          error.response?.data?.message || 
                          error.message || 
                          'Unknown error';

      return {
        success: false,
        error: errorMessage,
        retry: error.response?.status >= 500 || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT'
      };
    }
  }

  /**
   * Batch sync multiple entities
   */
  async batchSync(entities, fieldMappings = {}) {
    const results = {
      succeeded: [],
      failed: []
    };

    for (const entity of entities) {
      try {
        const result = await this.syncEntity(entity.entity_type, entity.entity_data, fieldMappings);
        
        if (result.success) {
          results.succeeded.push({
            entity_id: entity.entity_id,
            netsuite_id: result.netsuiteId
          });
        } else {
          results.failed.push({
            entity_id: entity.entity_id,
            error: result.error
          });
        }

        // Rate limiting - wait 100ms between requests
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`Batch sync error for entity ${entity.entity_id}:`, error);
        results.failed.push({
          entity_id: entity.entity_id,
          error: error.message
        });
      }
    }

    return results;
  }
}

module.exports = NetSuiteService;





