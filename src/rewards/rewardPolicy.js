const normalize = (value) => String(value || '').trim().toLowerCase();

export const isAudioLiveRewardTask = (task) => {
  const action = normalize(task?.action || task?.action_type || task?.live_type);
  const identity = normalize(`${task?.id || ''} ${task?.title || ''} ${task?.description || ''}`);
  return ['audio', 'audio_live', 'live_audio'].includes(action)
    || identity.includes('audio live')
    || identity.includes('audio_live');
};

export const isRetiredHostLiveRewardTask = (task) => {
  const action = normalize(task?.action || task?.action_type);
  const audience = normalize(task?.audience);
  return isAudioLiveRewardTask(task) || (action === 'live' && audience === 'host');
};

export const isTaskCenterRewardEligible = (task) => !isRetiredHostLiveRewardTask(task);

