/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:  ['Outfit', 'system-ui', 'sans-serif'],
        serif: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        mono:  ['"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      colors: {
        // ── Oxford Blue brand scale ─────────────────────────────────────────
        // brand-500: bright blue (for text accents on dark bg)
        // brand-600: dark navy  (for button bg — white text ≥ 4.5:1 in both themes)
        brand: {
          50:  '#eef4fb',
          100: '#d8eaf8',
          200: '#aaccea',
          300: '#6ea8d8',
          400: '#4a88c4',
          500: '#5a9fd6',  // bright blue (text accent on dark bg)
          600: '#1e3a5f',  // dark navy   (button bg, white text works)
          700: '#16304f',  // deeper navy (button hover)
          800: '#0e2040',
          900: '#081020',
        },
      },
    },
  },
  plugins: [],
}
