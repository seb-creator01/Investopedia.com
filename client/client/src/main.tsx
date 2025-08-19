import React from "react";
import ReactDOM from "react-dom/client";

const App = () => {
  return (
    <div>
      <h1>Welcome to Investorpedia</h1>
      <p>This is your React app running!</p>
    </div>
  );
};

const root = document.getElementById("root");

if (root) {
  const reactRoot = ReactDOM.createRoot(root);
  reactRoot.render(<App />);
}
