const axios = require('axios');

const {
  buildResponse,
  buildLinkAccountResponse,
  extractCustomSkillIdentity,
  trimString
} = require('../../shared/alexa/customSkill');

function getBrokerBaseUrl() {
  const value = trimString(process.env.HOMEBRAIN_BROKER_BASE_URL).replace(/\/+$/, '');
  if (!value) {
    throw new Error('HOMEBRAIN_BROKER_BASE_URL is required');
  }
  return value;
}

async function postToBroker(pathname, payload, options = {}) {
  const response = await axios.post(`${getBrokerBaseUrl()}${pathname}`, payload, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {})
    }
  });
  return response.data;
}

async function handler(event) {
  const identity = extractCustomSkillIdentity(event);

  if (!identity.accessToken && identity.requestType !== 'SessionEndedRequest') {
    return buildLinkAccountResponse();
  }

  try {
    const result = await postToBroker('/api/alexa/custom/dispatch', {
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

    const message = trimString(error.response?.data?.error || error.message) || 'HomeBrain could not process the Alexa custom skill request.';
    return {
      version: '1.0',
      response: {
        outputSpeech: {
          type: 'PlainText',
          text: message
        },
        card: {
          type: 'Simple',
          title: 'HomeBrain',
          content: message
        },
        shouldEndSession: true
      }
    };
  }
}

module.exports = {
  handler
};
