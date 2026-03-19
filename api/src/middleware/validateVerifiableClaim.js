/**
 * Middleware: Validate Verifiable Claim
 *
 * Verifies the NEP-413 verifiable_claim in the request body and sets
 * req.verifiedNearAccount to the claimed near_account_id.
 * All registrations require a valid verifiable claim.
 */

const NearVerificationService = require('../services/NearVerificationService');
const { BadRequestError } = require('../utils/errors');

async function validateVerifiableClaim(req, res, next) {
  const { verifiable_claim } = req.body || {};

  if (!verifiable_claim) {
    return next(new BadRequestError('verifiable_claim is required'));
  }

  try {
    await NearVerificationService.verifyClaim(verifiable_claim);
    req.verifiedNearAccount = verifiable_claim.near_account_id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { validateVerifiableClaim };
