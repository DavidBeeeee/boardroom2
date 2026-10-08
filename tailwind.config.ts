import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "var(--ink)",
        paper: "var(--bg)",
        card: "var(--card)",
        card2: "var(--card2)",
        teal: "var(--teal)",
        cyan: "var(--cyan)",
        gold: "var(--gold)",
        coral: "var(--coral)",
        soft: "var(--soft)",
        muted: "var(--muted)",
        cream: "var(--cream)",
        hubborder: "var(--border)",
      },
      fontFamily: {
        sans: ["'Nunito'", "var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["'Oswald'", "sans-serif"],
        serif: ["'Lora'", "var(--font-serif)", "Georgia", "serif"],
        mono: ["'Space Mono'", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "9px",
        md: "9px",
        lg: "12px",
        xl: "16px",
        "2xl": "20px",
        card: "16px",
        full: "999px",
      },
      boxShadow: {
        glow: "0 4px 20px var(--glow)",
        card: "0 8px 28px rgba(0, 0, 0, 0.12)",
      }
    }
  },
  plugins: [require("@tailwindcss/typography")]
};

export default config;
