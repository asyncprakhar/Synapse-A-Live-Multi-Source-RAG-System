  // src/App.jsx

  import React, { useState, useEffect, useRef } from 'react';
  import ReactMarkdown from 'react-markdown';
  import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
  import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
  import './App.css'; // We will create this CSS file next

  // A custom component for rendering code blocks with a copy button
  const CodeBlock = ({ node, inline, className, children, ...props }) => {
    const [copyText, setCopyText] = useState('Copy');
    const textToCopy = String(children).replace(/\n$/, '');

    const handleCopy = () => {
      navigator.clipboard.writeText(textToCopy).then(() => {
        setCopyText('Copied!');
        setTimeout(() => setCopyText('Copy'), 2000);
      });
    };

    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <div className="code-block-wrapper">
        <SyntaxHighlighter
          style={atomDark}
          language={match[1]}
          PreTag="div"
          {...props}
        >
          {textToCopy}
        </SyntaxHighlighter>
        <button className={`copy-code-btn ${copyText === 'Copied!' ? 'copied' : ''}`} onClick={handleCopy}>
          {copyText}
        </button>
      </div>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    );
  };

  function App() {
    // State management using React hooks
    const [apiKey, setApiKey] = useState(() => localStorage.getItem("apiKey") || "");
    const [question, setQuestion] = useState("");
    const [messages, setMessages] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const chatBoxRef = useRef(null);

    // Effect to scroll to the bottom of the chat box when new messages are added
    useEffect(() => {
      if (chatBoxRef.current) {
        chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
      }
    }, [messages, isLoading]);

    // Effect to persist the API key in local storage
    useEffect(() => {
      if (apiKey) {
        localStorage.setItem("apiKey", apiKey);
      } else {
        localStorage.removeItem("apiKey");
      }
    }, [apiKey]);

    const handleSubmit = async (e) => {
      e.preventDefault();
      if (isLoading || !question.trim() || !apiKey.trim()) return;

      // Add user message to state
      const userMessage = { role: 'user', content: question };
      setMessages(prev => [...prev, userMessage]);
      
      // Add a placeholder for the assistant's response
      const assistantPlaceholder = { role: 'assistant', content: '' };
      setMessages(prev => [...prev, assistantPlaceholder]);
      
      setIsLoading(true);
      setQuestion("");

      try {
        const response = await fetch("http://localhost:5678/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({ question }),
        });

        if (response.status === 401) throw new Error("Unauthorized: Invalid API Key.");
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n"); // SSE messages are separated by double newlines
          buffer = lines.pop(); // Keep incomplete message in buffer

          for (const line of lines) {
            if (line.startsWith("data:")) {
                try {
                  const data = JSON.parse(line.substring(5));
                  if (data.token) {
                    // Update the last message (the assistant's placeholder) with the new token
                    setMessages(prev => prev.map((msg, index) => 
                      index === prev.length - 1 ? { ...msg, content: msg.content + data.token } : msg
                    ));
                  }
                } catch (e) {
                  console.error("Failed to parse JSON from stream:", line);
                }
            }
          }
        }
      } catch (error) {
        setMessages(prev => prev.map((msg, index) => 
            index === prev.length - 1 ? { ...msg, content: `**Error:** ${error.message}` } : msg
        ));
      } finally {
        setIsLoading(false);
      }
    };

    return (
      <div id="chat-container">
        <div id="chat-box" ref={chatBoxRef}>
          <div className="message bot-message">
            <div className="message-content">
              <p>Hello! To get started, please enter your API Key below. I'm ready to help you with your knowledge base.</p>
            </div>
          </div>
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role}-message`}>
              <div className="message-content">
                <ReactMarkdown
                  components={{
                    code: CodeBlock,
                    a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.content === '' && (
            <div className="message bot-message">
              <div className="message-content">
                <div className="typing-indicator"><span></span><span></span><span></span></div>
              </div>
            </div>
          )}
        </div>
        <form id="input-form" onSubmit={handleSubmit}>
          <input 
            type="password" 
            id="api-key-input" 
            placeholder="Enter your API Key..." 
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="input-row">
            <input 
              type="text" 
              id="question-input"
              placeholder={apiKey ? "Ask a question..." : "Please enter your API key first."}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!apiKey || isLoading}
            />
            <button id="submit-btn" type="submit" disabled={!apiKey || isLoading}>
              {isLoading ? "Thinking..." : "Send"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  export default App;