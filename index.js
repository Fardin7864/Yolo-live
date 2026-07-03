import { Platform } from 'react-native';

if (Platform.OS !== 'web') {
  const { getMessaging, setBackgroundMessageHandler } = require('@react-native-firebase/messaging');
  const { logBackgroundPushMessage } = require('./src/lib/firebase');

  setBackgroundMessageHandler(getMessaging(), async (remoteMessage) => {
    await logBackgroundPushMessage(remoteMessage);
  });
}

require('expo-router/entry');
