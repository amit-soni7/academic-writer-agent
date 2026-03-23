/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // design.md §3: Manrope for UI, Newsreader for content
        sans:  ['Manrope', 'system-ui', 'sans-serif'],
        serif: ['Newsreader', 'Georgia', 'serif'],
        mono:  ['"JetBrains Mono"', 'Menlo', 'monospace'],
        // Legacy aliases (some components reference these)
        ui:      ['Manrope', 'system-ui', 'sans-serif'],
        content: ['Newsreader', 'Georgia', 'serif'],
      },
      colors: {
        // ── "Vibrant Intelligence" primary — Deep Indigo (design.md §2) ────
        brand: {
          50:  '#e2dfff',   // primary-fixed
          100: '#d5d3ff',
          200: '#bdc2ff',   // primary-fixed-dim
          300: '#9b9ef0',
          400: '#6e6fdb',
          500: '#504ed0',   // primary-container
          600: '#3632b7',   // primary
          700: '#2a27a0',
          800: '#1f1c88',
          900: '#0b006b',   // on-primary-fixed
        },
      },
      borderRadius: {
        // design.md §5: xl roundedness for buttons
        'xl': '1.5rem',
        'full': '9999px',
      },
    },
  },
  plugins: [],
}
