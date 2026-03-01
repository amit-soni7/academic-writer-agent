/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#3f3f46',
          600: '#27272a',
          700: '#18181b',
          800: '#09090b',
          900: '#000000',
        },
        blue: {
          50:  '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          500: '#71717a',
          600: '#3f3f46',
          700: '#27272a',
          900: '#09090b',
        },
        indigo: {
          50:  '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          500: '#71717a',
          600: '#3f3f46',
          700: '#27272a',
          900: '#09090b',
        },
      },
    },
  },
  plugins: [],
}
