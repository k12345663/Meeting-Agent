const url = "https://us05web.zoom.us/j/83392905707 i want it to join this meeting";
try {
  let u = new URL(url);
  console.log("Valid:", u.toString());
} catch(e) {
  console.log("Error:", e.message);
}
