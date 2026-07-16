import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.enkai.spaceflightsim',
  appName: 'Space Flight Simulator',
  webDir: 'dist',
  backgroundColor: '#000000',
  ios: {
    contentInset: 'never',
  },
};

export default config;
