export const BOARDROOM_BASE_PATH = "/boardroom";

export function boardroomPath(path = "") {
  if (!path || path === "/") return BOARDROOM_BASE_PATH;
  return `${BOARDROOM_BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}
