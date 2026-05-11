/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: {
          bg: "#0b0f14",
          panel: "#101720",
          panel2: "#151e29",
          border: "#263241",
          text: "#d7e1ef",
          muted: "#7f8da3",
          accent: "#64d2ff",
          green: "#51d88a",
          yellow: "#f6c760",
          red: "#ff6b6b"
        }
      }
    },
  },
  plugins: [],
}
