/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './app.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        brand: {
          50:  '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
      },
    },
  },
  // Safelist forces classes that are dynamically computed in JS and might
  // not be detected by the static content scanner.
  safelist: [
    '!text-cyan-300',  // criteria_met active-sort modifier (Tailwind !important prefix)
  ],
  plugins: [],
}
