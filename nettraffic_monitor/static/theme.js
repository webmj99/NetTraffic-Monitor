"use strict";
/* Sets data-theme before first paint: the saved light/dark choice, otherwise the system setting (app.js follows its changes). */
const savedTheme = () => { try { const th = localStorage.getItem("theme"); return th === "light" || th === "dark" ? th : null; } catch { return null; } };
document.documentElement.dataset.theme = savedTheme() || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
