export type AppNavigationDestination =
  | "command_center"
  | "email"
  | "chat"
  | "settings";

export type AppUiAction =
  | {
      type: "navigate";
      url: string;
      label: string;
    }
  | {
      type: "open_email";
      url: string;
      label: string;
    }
  | {
      type: "open_chat";
      url: string;
      label: string;
    };

const APP_NAVIGATION_ACTIONS: Record<AppNavigationDestination, AppUiAction> = {
  command_center: {
    type: "navigate",
    url: "/dashboard",
    label: "Command Center",
  },
  email: {
    type: "open_email",
    url: "/email",
    label: "Email",
  },
  chat: {
    type: "open_chat",
    url: "/chat",
    label: "Chat",
  },
  settings: {
    type: "navigate",
    url: "/settings",
    label: "Settings",
  },
};

export function appUiActionForDestination(
  destination: AppNavigationDestination,
): AppUiAction {
  return APP_NAVIGATION_ACTIONS[destination];
}
