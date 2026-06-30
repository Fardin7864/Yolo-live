/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#FF2E7E',
          dark: '#E0266D',
          light: '#FF5A9D',
        },
        secondary: {
          DEFAULT: '#1A1230', // Deep Purple Background
          light: '#251B45',    // Card/Surface color
        },
        accent: {
          purple: '#6B4EFF',
          blue: '#2E8BFF',
        },
        success: '#00D084',
        warning: '#FFB800',
        error: '#FF4D4D',
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
      },
      borderRadius: {
        '3xl': '24px',
        '4xl': '32px',
      }
    },
  },
  plugins: [],
}
