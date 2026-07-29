/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#2b2b2b', soft: '#5c5c5c', faint: '#8a8a8a' },
        paper: { DEFAULT: '#ffffff', soft: '#fafafa', deep: '#f5f5f5' },
        accent: { DEFAULT: '#3b82f6', soft: '#5b8def' },
        ok: '#2faa5d',
        err: '#d9534f',
        warn: '#e0a800',
        line: '#e6e6e6',
      },
      fontFamily: {
        app: [
          '-apple-system',
          "'Segoe UI'",
          "'PingFang SC'",
          "'Microsoft YaHei'",
          'sans-serif',
        ],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
