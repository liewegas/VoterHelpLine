const MessageConstants = require('./message_constants');
const SlackApiUtil = require('./slack_api_util');
const TwilioApiUtil = require('./twilio_api_util');
const MessageParserUtil = require('./message_parser_util');
const RouterUtil = require('./router_util');
const DbApiUtil = require('./db_api_util');
const RedisApiUtil = require('./redis_api_util');
const LoadBalancer = require('./load_balancer');
const Hashes = require('jshashes'); // v1.0.5

const MINS_BEFORE_WELCOME_BACK_MESSAGE = 60;

exports.handleNewVoter = (userOptions, redisClient, twilioPhoneNumber, inboundDbMessageEntry) => {
  const userPhoneNumber = userOptions.userPhoneNumber;
  const userMessage = userOptions.userMessage;

  const userInfo = {};

  const MD5 = new Hashes.MD5;
  userInfo.userId = MD5.hex(userPhoneNumber);
  userInfo.messageHistory = [`${userInfo.userId}: ${userMessage}`, `Automated Message: ${MessageConstants.WELCOME_AND_DISCLAIMER}`];
  userInfo.isDemo = false;
  if (twilioPhoneNumber == process.env.DEMO_PHONE_NUMBER || userPhoneNumber == process.env.TESTER_PHONE_NUMBER) {
    userInfo.isDemo = true;
  }
  userInfo.confirmedDisclaimer = false;

  let welcomeMessage = MessageConstants.WELCOME_AND_DISCLAIMER;
  userInfo.lobbyChannel = "#lobby";
  let operatorMessage = `<!channel> Operator: New voter! (${userInfo.userId}).`;

  if (userInfo.isDemo) {
    userInfo.lobbyChannel = "#demo-lobby";
  }

  userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);

  // Welcome the voter
  TwilioApiUtil.sendMessage(welcomeMessage, {userPhoneNumber, twilioPhoneNumber},
      DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
    );

  // In Slack, create entry channel message, followed by voter's message and intro text.
  SlackApiUtil.sendMessage(operatorMessage,
  {
    channel: userInfo.lobbyChannel,
  }).then(response => {
    // Remember the lobby thread for this user.
    userInfo.lobbyParentMessageTs = response.data.ts;

    // Reassign the channel to the ID version.
    userInfo.lobbyChannel = response.data.channel;

    // Pass the voter's message along to the Slack lobby thread,
    // and show in the Slack lobby thread the welcome message the voter received
    // in response.
    SlackApiUtil.sendMessage(`${userInfo.userId}: ${userMessage}`,
      {parentMessageTs: userInfo.lobbyParentMessageTs, channel: userInfo.lobbyChannel}, inboundDbMessageEntry, userInfo).then(() => {
        SlackApiUtil.sendMessage(`Automated Message: ${welcomeMessage}`,
          {parentMessageTs: userInfo.lobbyParentMessageTs, channel: userInfo.lobbyChannel});
      });

    // Add key/value such that given a user phone number we can get the
    // Slack lobby thread associated with that user.
    RedisApiUtil.setHash(redisClient, `${userPhoneNumber}:${twilioPhoneNumber}`, userInfo);

    // Add key/value such that given Slack thread data we can get a
    // user phone number.
    RedisApiUtil.setHash(redisClient, `${userInfo.lobbyChannel}:${userInfo.lobbyParentMessageTs}`,
                        {userPhoneNumber, twilioPhoneNumber});
  });
};

const introduceVoterToStateChannel = (userOptions, redisClient, twilioPhoneNumber) => {
  const userPhoneNumber = userOptions.userPhoneNumber;
  const userInfo = userOptions.userInfo;
  const userId = userInfo.userId;

  // Create thread in state channel.
  return SlackApiUtil.sendMessage(`<!channel> Operator: New ${userInfo.stateName} voter! (${userId}).`,
    {channel: userInfo.stateChannelChannel}).then(response => {
      userInfo.stateChannelParentMessageTs = response.data.ts;

      // Reassign the channel to the ID version.
      userInfo.stateChannelChannel = response.data.channel;

      // Remember state channel thread identifying info.
      RedisApiUtil.setHash(redisClient, `${userPhoneNumber}:${twilioPhoneNumber}`, userInfo);

      // Be able to identify phone number using STATE channel identifying info.
      RedisApiUtil.setHash(redisClient,
        `${response.data.channel}:${userInfo.stateChannelParentMessageTs}`,
        {userPhoneNumber, twilioPhoneNumber});

      // Populate state channel thread with message history so far.
      return SlackApiUtil.sendMessages(userInfo.messageHistory, {parentMessageTs: userInfo.stateChannelParentMessageTs,
                                                 channel: userInfo.stateChannelChannel});
    });
};

exports.determineVoterState = (userOptions, redisClient, twilioPhoneNumber, inboundDbMessageEntry) => {
  const userInfo = userOptions.userInfo;
  const userPhoneNumber = userOptions.userPhoneNumber;
  const userId = userInfo.userId;
  const userMessage = userOptions.userMessage;

  userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);

  userInfo.messageHistory.push(`${userId}: ${userMessage}`);
  return SlackApiUtil.sendMessage(`${userId}: ${userMessage}`, {
    parentMessageTs: userInfo.lobbyParentMessageTs,
    channel: userInfo.lobbyChannel},
    inboundDbMessageEntry, userInfo).then(response => {
      const stateName = MessageParserUtil.determineState(userMessage);
      if (stateName == null) {
        console.log("State not determined");
        TwilioApiUtil.sendMessage(MessageConstants.CLARIFY_STATE, {userPhoneNumber, twilioPhoneNumber},
          DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
        );
        SlackApiUtil.sendMessage(`Automated Message: ${MessageConstants.CLARIFY_STATE}`,
          {parentMessageTs: userInfo.lobbyParentMessageTs, channel: userInfo.lobbyChannel});
        userInfo.messageHistory.push(`Automated Message: ${MessageConstants.CLARIFY_STATE}`);

        userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);
        return RedisApiUtil.setHash(redisClient, `${userPhoneNumber}:${twilioPhoneNumber}`, userInfo);
      } else {
        userInfo.stateName = stateName;

        TwilioApiUtil.sendMessage(MessageConstants.STATE_CONFIRMATION(stateName), {userPhoneNumber, twilioPhoneNumber},
          DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
        );
        userInfo.messageHistory.push(`Automated Message: ${MessageConstants.STATE_CONFIRMATION(stateName)}`);

        // Slack channel name must abide by the rules in this function.
        return LoadBalancer.selectChannelByRoundRobin(redisClient, userInfo.isDemo, stateName).then(selectedChannel => {
          userInfo.stateChannelChannel = selectedChannel;
          SlackApiUtil.sendMessages([`Automated Message: ${MessageConstants.STATE_CONFIRMATION(stateName)}`,
                                      `Operator: Routing voter to #${userInfo.stateChannelChannel}.`],
                                    {parentMessageTs: userInfo.lobbyParentMessageTs, channel: userInfo.lobbyChannel});

          return introduceVoterToStateChannel({userPhoneNumber, userId, userInfo}, redisClient, twilioPhoneNumber);
        });
      }
    });
};

exports.handleDisclaimer = (userOptions, redisClient, twilioPhoneNumber, inboundDbMessageEntry) => {
  const userInfo = userOptions.userInfo;
  const userId = userInfo.userId;
  const userMessage = userOptions.userMessage;
  const slackLobbyMessageParams = {
      parentMessageTs: userInfo.lobbyParentMessageTs,
      channel: userInfo.lobbyChannel,
    };
  userInfo.messageHistory.push(`${userId}: ${userMessage}`);

  const nowSecondsEpoch = Math.round(Date.now() / 1000);
  userInfo.lastVoterMessageSecsFromEpoch = nowSecondsEpoch;

  SlackApiUtil.sendMessage(`${userId}: ${userMessage}`, slackLobbyMessageParams, inboundDbMessageEntry, userInfo).then(response => {
      const userMessageNoPunctuation = userOptions.userMessage.replace(/[.,?\/#!$%\^&\*;:{}=\-_`~()]/g, '');
      const cleared = userMessageNoPunctuation.toLowerCase().trim() == "agree";
      let automatedMessage;
      if (cleared) {
        userInfo.confirmedDisclaimer = true;
        automatedMessage = MessageConstants.DISCLAIMER_CONFIRMATION_AND_STATE_QUESTION;
      } else {
        automatedMessage = MessageConstants.CLARIFY_DISCLAIMER;
      }
      userInfo.messageHistory.push(`Automated Message: ${automatedMessage}`);
      RedisApiUtil.setHash(redisClient, `${userOptions.userPhoneNumber}:${twilioPhoneNumber}`, userInfo);
      TwilioApiUtil.sendMessage(automatedMessage, {userPhoneNumber: userOptions.userPhoneNumber, twilioPhoneNumber},
        DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
      );
      SlackApiUtil.sendMessage(`Automated Message: ${automatedMessage}`, slackLobbyMessageParams);
    });
};

exports.handleClearedVoter = (userOptions, redisClient, twilioPhoneNumber, inboundDbMessageEntry) => {
  const userInfo = userOptions.userInfo;
  const userId = userInfo.userId;
  const userPhoneNumber = userOptions.userPhoneNumber;
  const slackStateChannelMessageParams = {
      parentMessageTs: userInfo.stateChannelParentMessageTs,
      channel: userInfo.stateChannelChannel,
    };

  const nowSecondsEpoch = Math.round(Date.now() / 1000);
  // Remember the lastVoterMessageSecsFromEpoch, for use in calculation below.
  const lastVoterMessageSecsFromEpoch = userInfo.lastVoterMessageSecsFromEpoch;
  // Update the lastVoterMessageSecsFromEpoch, for use in DB write below.
  userInfo.lastVoterMessageSecsFromEpoch = nowSecondsEpoch;

  return SlackApiUtil.sendMessage(`${userId}: ${userOptions.userMessage}`,
    slackStateChannelMessageParams,
    inboundDbMessageEntry, userInfo).then(response => {
      console.log(`Seconds since last message from voter: ${nowSecondsEpoch - lastVoterMessageSecsFromEpoch}`);

      if (nowSecondsEpoch - lastVoterMessageSecsFromEpoch > MINS_BEFORE_WELCOME_BACK_MESSAGE * 60) {
        const welcomeBackMessage = MessageConstants.WELCOME_BACK(userInfo.stateName);
        TwilioApiUtil.sendMessage(welcomeBackMessage, {userPhoneNumber: userOptions.userPhoneNumber, twilioPhoneNumber});
        SlackApiUtil.sendMessage(`Automated Message: ${welcomeBackMessage}`, slackStateChannelMessageParams);
      }

      return RedisApiUtil.setHash(redisClient, `${userPhoneNumber}:${twilioPhoneNumber}`, userInfo);
    });
};
