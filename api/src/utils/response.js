/**
 * Response helper functions
 */

/**
 * Send success response
 * 
 * @param {Response} res - Express response
 * @param {Object} data - Response data
 * @param {number} statusCode - HTTP status code
 */
function success(res, data, statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    ...data
  });
}

/**
 * Send created response
 * 
 * @param {Response} res - Express response
 * @param {Object} data - Created resource data
 */
function created(res, data) {
  success(res, data, 201);
}

/**
 * Send paginated response
 * 
 * @param {Response} res - Express response
 * @param {Array} items - Items array
 * @param {Object} pagination - Pagination info
 */
function paginated(res, items, pagination) {
  success(res, {
    data: items,
    pagination: {
      count: items.length,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: items.length === pagination.limit
    }
  });
}

module.exports = {
  success,
  created,
  paginated,
};
