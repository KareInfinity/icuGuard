// Simple environment configuration
// Change this one value to configure your server
const SERVER_BASE = 'vc2txt.quantosaas.com'; // Server IP:port
// const SERVER_BASE = '192.168.1.13:8111'; // Server IP:port

export const ENV = {
  // Development environment
  DEV: {
    SERVER_BASE: SERVER_BASE,
  },
  
  // Production environment
  PROD: {
    SERVER_BASE: SERVER_BASE,
  },
};

// Get current environment
const getCurrentEnvironment = () => {
  return __DEV__ ? ENV.DEV : ENV.PROD;
};

// Export current environment
export const CURRENT_ENV = getCurrentEnvironment();

// Helper functions to construct URLs with platform-specific handling
export const getWSServer = () => {
  const base = CURRENT_ENV.SERVER_BASE;
  
  // Ensure proper protocol
  if (!base.startsWith('ws://') && !base.startsWith('wss://')) {
    return `ws://${base}`;
  }
  
  return base;
};

export const getAPIServer = () => {
  const base = CURRENT_ENV.SERVER_BASE;
  
  // Ensure proper protocol
  if (!base.startsWith('http://') && !base.startsWith('https://')) {
    return `http://${base}`;
  }
  
  return base;
};

// Platform-specific WebSocket URL helper
export const getPlatformWSUrl = (endpoint: string = '/ws/transcribe') => {
  const base = getWSServer();
  const cleanBase = base.replace(/\/$/, ''); // Remove trailing slash
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  return `${cleanBase}${cleanEndpoint}`;
};

// Platform-specific API URL helper
export const getPlatformAPIUrl = (endpoint: string = '') => {
  const base = getAPIServer();
  const cleanBase = base.replace(/\/$/, ''); // Remove trailing slash
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : endpoint ? `/${endpoint}` : '';
  
  return `${cleanBase}${cleanEndpoint}`;
};

// For easy configuration - just change the SERVER_BASE value above
export const SERVER_CONFIG = {
  BASE_ADDRESS: SERVER_BASE,
  WS_ENDPOINT: '/ws/transcribe',
  API_ENDPOINT: '',
}; 