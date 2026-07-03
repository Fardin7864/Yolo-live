import React from 'react';
import { View } from 'react-native';

const noop = () => {};

const engine = {
  initialize: noop,
  registerEventHandler: noop,
  unregisterEventHandler: noop,
  enableVideo: noop,
  disableVideo: noop,
  enableAudio: noop,
  enableLocalVideo: noop,
  muteLocalVideoStream: noop,
  muteLocalAudioStream: noop,
  muteAllRemoteVideoStreams: noop,
  startPreview: noop,
  stopPreview: noop,
  setVideoEncoderConfiguration: noop,
  setClientRole: noop,
  joinChannel: noop,
  leaveChannel: noop,
  release: noop,
  renewToken: noop,
  updateChannelMediaOptions: noop,
  enableAudioVolumeIndication: noop,
  switchCamera: noop,
};

export const createAgoraRtcEngine = () => engine;

export const ChannelProfileType = {
  ChannelProfileLiveBroadcasting: 1,
};

export const ClientRoleType = {
  ClientRoleBroadcaster: 1,
  ClientRoleAudience: 2,
};

export const OrientationMode = {
  OrientationModeAdaptive: 0,
};

export const DegradationPreference = {
  MaintainBalanced: 1,
};

export function RtcSurfaceView({ style }) {
  return <View pointerEvents="none" style={style} />;
}
