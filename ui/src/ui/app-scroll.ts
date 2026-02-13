/** Distance (px) from the bottom within which we consider the user "near bottom".
 *  200px ≈ one short chat message — enough to avoid accidental disengage from
 *  minor scroll jitter, but small enough that a deliberate scroll-up of ~1
 *  message immediately opts the user out of auto-scroll. */
const NEAR_BOTTOM_THRESHOLD = 200;

type ScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  style: CSSStyleDeclaration;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatNewMessagesBelow: boolean;
  chatStream: string | null;
  /** Tracks the last scrollTop seen by handleChatScroll, used to detect
   *  user-initiated upward scrolls vs. content-growth scroll events. */
  chatLastScrollTop: number;
  logsScrollFrame: number | null;
  logsAtBottom: boolean;
  topbarObserver: ResizeObserver | null;
};

export function scheduleChatScroll(host: ScrollHost, force = false) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
  }
  if (host.chatScrollTimeout != null) {
    clearTimeout(host.chatScrollTimeout);
    host.chatScrollTimeout = null;
  }
  const pickScrollTarget = () => {
    const container = host.querySelector(".chat-thread") as HTMLElement | null;
    if (container) {
      return container;
    }
    return (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
  };
  // Wait for Lit render to complete, then scroll
  void host.updateComplete.then(() => {
    host.chatScrollFrame = requestAnimationFrame(() => {
      host.chatScrollFrame = null;
      const target = pickScrollTarget();
      if (!target) {
        return;
      }
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;

      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;

      // After the first auto-scroll, rely exclusively on chatUserNearBottom
      // (maintained by handleChatScroll) instead of the distance fallback.
      // The distance check is only used for the initial load when no scroll
      // events have fired yet, so chatUserNearBottom hasn't been calibrated.
      // Without this guard, the 2s polling cycle (loadChatHistory) would yank
      // the user to the bottom whenever they were within 450px of it —
      // preventing them from reading the latest content in peace.
      const shouldStick = host.chatHasAutoScrolled
        ? effectiveForce || host.chatUserNearBottom
        : effectiveForce || host.chatUserNearBottom || distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

      if (!shouldStick) {
        // User is scrolled up — flag that new content arrived below.
        host.chatNewMessagesBelow = true;
        return;
      }
      if (effectiveForce) {
        host.chatHasAutoScrolled = true;
      }
      target.scrollTop = target.scrollHeight;
      host.chatLastScrollTop = target.scrollTop;
      host.chatUserNearBottom = true;
      host.chatNewMessagesBelow = false;
      const retryDelay = effectiveForce ? 150 : 120;
      host.chatScrollTimeout = window.setTimeout(() => {
        host.chatScrollTimeout = null;
        const latest = pickScrollTarget();
        if (!latest) {
          return;
        }
        const latestDistanceFromBottom =
          latest.scrollHeight - latest.scrollTop - latest.clientHeight;
        const shouldStickRetry = host.chatHasAutoScrolled
          ? effectiveForce || host.chatUserNearBottom
          : effectiveForce ||
            host.chatUserNearBottom ||
            latestDistanceFromBottom < NEAR_BOTTOM_THRESHOLD;
        if (!shouldStickRetry) {
          return;
        }
        latest.scrollTop = latest.scrollHeight;
        host.chatLastScrollTop = latest.scrollTop;
        host.chatUserNearBottom = true;
      }, retryDelay);
    });
  });
}

export function scheduleLogsScroll(host: ScrollHost, force = false) {
  if (host.logsScrollFrame) {
    cancelAnimationFrame(host.logsScrollFrame);
  }
  void host.updateComplete.then(() => {
    host.logsScrollFrame = requestAnimationFrame(() => {
      host.logsScrollFrame = null;
      const container = host.querySelector(".log-stream") as HTMLElement | null;
      if (!container) {
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick = force || distanceFromBottom < 80;
      if (!shouldStick) {
        return;
      }
      container.scrollTop = container.scrollHeight;
    });
  });
}

export function handleChatScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

  if (nearBottom) {
    // User is near the bottom — always enable auto-scroll.
    host.chatUserNearBottom = true;
  } else if (host.chatStream !== null) {
    // During streaming: only disable auto-scroll on genuine USER scroll-up.
    // Content growth increases scrollHeight without changing scrollTop, which
    // increases distanceFromBottom. Without this guard, content growth would
    // falsely set chatUserNearBottom=false and show the "New Messages" button,
    // pinning the user away from the stream. By checking whether scrollTop
    // actually decreased, we distinguish "user scrolled up" from "new content
    // pushed the bottom further away."
    if (container.scrollTop < host.chatLastScrollTop) {
      host.chatUserNearBottom = false;
    }
    // If scrollTop stayed the same or increased (programmatic scroll / content
    // growth), chatUserNearBottom is left unchanged — auto-scroll continues.
  } else {
    // Not streaming: standard threshold-based detection.
    host.chatUserNearBottom = false;
  }

  host.chatLastScrollTop = container.scrollTop;

  // Clear the "new messages below" indicator when user scrolls back to bottom.
  if (host.chatUserNearBottom) {
    host.chatNewMessagesBelow = false;
  }
}

export function handleLogsScroll(host: ScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  host.logsAtBottom = distanceFromBottom < 80;
}

export function resetChatScroll(host: ScrollHost) {
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatNewMessagesBelow = false;
  host.chatLastScrollTop = 0;
}

export function exportLogs(lines: string[], label: string) {
  if (lines.length === 0) {
    return;
  }
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  anchor.href = url;
  anchor.download = `openclaw-logs-${label}-${stamp}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function observeTopbar(host: ScrollHost) {
  if (typeof ResizeObserver === "undefined") {
    return;
  }
  const topbar = host.querySelector(".topbar");
  if (!topbar) {
    return;
  }
  const update = () => {
    const { height } = topbar.getBoundingClientRect();
    host.style.setProperty("--topbar-height", `${height}px`);
  };
  update();
  host.topbarObserver = new ResizeObserver(() => update());
  host.topbarObserver.observe(topbar);
}
