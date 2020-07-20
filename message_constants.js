exports.CLARIFY_STATE = "I'm sorry I didn't understand. In which U.S. state are you looking to vote? We currently service FL, NC and OH.";
exports.CLARIFY_DISCLAIMER = 'Please reply “agree” to confirm that you understand and would like to continue.';

exports.STATE_CONFIRMATION_AND_DISCLAIMER = state => `Great! We are connecting you with a ${state} volunteer.\n\nPlease note that this is not an official or government-affiliated service. Volunteers will do their best to share official links that support their answers to your questions, but by using this service you release us of all liability for your personal voting experience.\n\nReply "agree" to confirm that you understand and would like to continue.`;
exports.DISCLAIMER_CONFIRMATION = "Great! We are finding a volunteer. We try to reply within minutes but may take up to 24 hours.";

exports.WELCOME = "Welcome to the Voter Help Line! To match you with the most knowlegeable volunteer, in which U.S. state are you looking to vote? We currently service FL, NC and OH. (Msg & data rates may apply).";
exports.WELCOME_NC = "Welcome to the Voter Help Line! We are finding an available volunteer -- in the meantime, please tell us more about how we can help you vote. Please note that we currently only service North Carolina. (Msg & data rates may apply).";

exports.WELCOME_BACK = state => `Welcome back! We are connecting you with a ${state} volunteer. We try to find someone within minutes, but depending on the time of day, you might hear back later. In the meantime, please feel free to share more information about your question and situation. (Msg & data rates may apply).`;
