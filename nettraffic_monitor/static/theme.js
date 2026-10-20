"use strict";
/* Applies the saved light/dark choice before first paint (no saved choice = follow the system). */
try { const th = localStorage.getItem("theme"); if (th === "light" || th === "dark") document.documentElement.dataset.theme = th; } catch {}
