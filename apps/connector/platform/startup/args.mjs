function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Arguments that must survive login/startup supervision. In particular, the
 * licensed update endpoint is required even when optional runtimes are off.
 */
export function buildPersistentConnectorArgs(options = {}) {
  const appUrl = clean(options.appUrl);
  const whatsappEnabled = options.whatsappEnabled === true;
  const whatsappGroupName = clean(options.whatsappGroupName);

  return [
    ...(appUrl ? ["--app-url", appUrl] : []),
    ...(whatsappEnabled ? ["--whatsapp"] : []),
    ...(whatsappEnabled && whatsappGroupName
      ? ["--whatsapp-group", whatsappGroupName]
      : []),
  ];
}
