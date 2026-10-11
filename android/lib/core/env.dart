/// Deploy-time configuration. Overridable with --dart-define, but defaults to
/// the live DevNexus backend so the app runs with no setup.
class Env {
  static const apiBase = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'https://ht1rtpk2jj.execute-api.ap-south-1.amazonaws.com',
  );
  static const wsBase = String.fromEnvironment(
    'WS_BASE',
    defaultValue: 'wss://ep4rx5ngha.execute-api.ap-south-1.amazonaws.com/dev',
  );

  /// The FCM/local-notification channel the native side also declares in the
  /// AndroidManifest. They MUST match or background notifications get no channel.
  static const alertsChannelId = 'devnexus_alerts_v3';
}
