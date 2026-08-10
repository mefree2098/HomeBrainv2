const {
  buildResponse,
  buildLinkAccountResponse,
  extractCustomSkillIdentity,
  trimString
} = require('../../shared/alexa/customSkill');
const { createBrokerClient } = require('./brokerClient');

function buildSessionEndedResponse() {
  return {
    version: '1.0',
    response: {}
  };
}

function logFailure(error, identity, context, startedAt) {
  const statusCode = Number(error?.response?.status || error?.statusCode || error?.status || 0);
  console.error(JSON.stringify({
    event: 'homebrain_alexa_custom_lambda_failure',
    awsRequestId: trimString(context?.awsRequestId),
    requestType: identity.requestType || 'unknown',
    intentName: identity.intentName || undefined,
    requestId: identity.requestId || undefined,
    statusCode: statusCode || undefined,
    errorCode: trimString(error?.code) || undefined,
    durationMs: Date.now() - startedAt
  }));
}

async function handler(event, context = {}) {
  const identity = extractCustomSkillIdentity(event);
  const startedAt = Date.now();

  if (identity.requestType === 'SessionEndedRequest') {
    return buildSessionEndedResponse();
  }

  if (!identity.accessToken) {
    return buildLinkAccountResponse();
  }

  try {
    const brokerClient = createBrokerClient(context);
    const result = await brokerClient.post('/api/alexa/custom/dispatch', {
      envelope: event,
      requestType: identity.requestType,
      intentName: identity.intentName,
      locale: identity.locale
    }, {
      bearerToken: identity.accessToken
    });

    if (result?.version && result?.response) {
      return result;
    }

    if (result?.alexaResponse?.version && result?.alexaResponse?.response) {
      return result.alexaResponse;
    }

    return buildResponse({
      text: trimString(result?.spokenText || result?.resultText) || 'Done.',
      shouldEndSession: result?.shouldEndSession !== false,
      repromptText: trimString(result?.repromptText),
      cardTitle: trimString(result?.cardTitle) || 'HomeBrain'
    });
  } catch (error) {
    if ((error.response?.status || 0) === 401) {
      return buildLinkAccountResponse();
    }

    logFailure(error, identity, context, startedAt);
    return buildResponse({
      text: 'HomeBrain could not process that Alexa request. Please try again.',
      shouldEndSession: true,
      cardTitle: 'HomeBrain'
    });
  }
}

module.exports = {
  handler
};
