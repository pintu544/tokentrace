/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0f14',
        panel: '#11161d',
        line: '#1f2733',
        dim: '#8b98a9',
      },
    },
  },
  plugins: [],
};
