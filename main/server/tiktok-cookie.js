import { globalTikTokAuthManager } from "./tiktok-auth-session.js";

/**
 * Captures TikTok cookies using the secure isolated session partition.
 * Backward compatible wrapper around globalTikTokAuthManager.openLoginWindow.
 */
export async function captureTikTokCookies(parentWindow) {
  const result = await globalTikTokAuthManager.openLoginWindow(parentWindow);

  if (result.status === "success") {
    const cookies = globalTikTokAuthManager.getCookies();
    return {
      status: "success",
      sessionId: cookies["sessionid"],
      ttTargetIdc: cookies["tt-target-idc"],
      connectedAs: globalTikTokAuthManager.getConnectedAs(),
    };
  }

  return result;
}
