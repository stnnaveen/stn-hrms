import type { CapacitorConfig } from '@capacitor/cli';

// v2: the same web build, wrapped for the Play Store and App Store. Phone features stay behind src/device/*.
const config: CapacitorConfig = {
  appId: 'in.startuptn.hr',
  appName: 'StartupTN HR',
  webDir: 'dist',
  android: {
    // background location: keeps updates flowing after 5 min in the background (plugin README)
    useLegacyBridge: true
  },
  plugins: {
    LocalNotifications: { smallIcon: 'ic_stat_tracking', iconColor: '#FF7A4F' }
  }
};

export default config;
