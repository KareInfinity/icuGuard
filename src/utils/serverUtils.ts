// Server URL utility functions that work with Redux state
// These functions accept the server URL from Redux and construct proper URLs

export const getCustomWSServer = (customServerUrl: string) => {
  // Ensure proper protocol
  if (!customServerUrl.startsWith('ws://') && !customServerUrl.startsWith('wss://')) {
    return `ws://${customServerUrl}`;
  }
  
  return customServerUrl;
};

export const getCustomAPIServer = (customServerUrl: string) => {
  // Ensure proper protocol
  if (!customServerUrl.startsWith('http://') && !customServerUrl.startsWith('https://')) {
    return `http://${customServerUrl}`;
  }
  
  return customServerUrl;
};

export const getCustomPlatformWSUrl = (customServerUrl: string, endpoint: string = '/ws/transcribe') => {
  const base = getCustomWSServer(customServerUrl);
  const cleanBase = base.replace(/\/$/, ''); // Remove trailing slash
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  return `${cleanBase}${cleanEndpoint}`;
};

export const getCustomPlatformAPIUrl = (customServerUrl: string, endpoint: string = '') => {
  const base = getCustomAPIServer(customServerUrl);
  const cleanBase = base.replace(/\/$/, ''); // Remove trailing slash
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : endpoint ? `/${endpoint}` : '';
  
  return `${cleanBase}${cleanEndpoint}`;
};

// Default server configuration
export const DEFAULT_SERVER_URL = 'vc2txt.quantosaas.com'; 