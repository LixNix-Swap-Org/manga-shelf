/** @type {import('tailwindcss').Config} */
export default {
  // hover styles only where a real pointer exists (touch screens keep the pressed look otherwise)
  future: { hoverOnlyWhenSupported: true },
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },
        slate: {
          850: '#172033',
        }
      },
      spacing: {
        13: '3.25rem',
        18: '4.5rem',
        26: '6.5rem',
      },
      // the lightbox opens from inside z-50 dialogs (volume editor) and must stack above them
      zIndex: {
        60: '60',
      },
      boxShadow: {
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      },
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' },
        },
      },
      animation: {
        shake: 'shake 0.4s ease-in-out',
      },
    },
  },
  plugins: [
    // landscape phones (and a phone with the keyboard open): compact dialog headers, the whole dialog scrolls; `:root`
    // lifts the specificity, so short: wins over sm:/supports-[]: utilities, which Tailwind emits after plugin variants
    ({ addVariant }) => addVariant('short', '@media (max-height: 500px) { :root & }'),
  ],
}
