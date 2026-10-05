const root = document.getElementById("root");

if (root) {
  void Promise.all([
    import("react-dom/client"),
    import("./App"),
    import("./styles.css"),
  ]).then(([{ createRoot }, { default: App }]) => {
    createRoot(root).render(<App />);
  }).catch((error: unknown) => {
    console.error("取景台界面启动失败", error);
  });
}
