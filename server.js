require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createServer } = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory storage (replace with a database in production)
let users = [];
let activities = [];
let chatMessages = [];
let onlineUsers = new Map();

// Email configuration (replace with your actual email service)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Routes

// User registration
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  
  // Check if user already exists
  if (users.find(user => user.email === email)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  
  // Create new user
  const newUser = {
    id: Date.now(),
    name,
    email,
    password, // In production, hash this password
    verified: false,
    verificationPending: false,
    createdAt: new Date()
  };
  
  users.push(newUser);
  
  // Log activity
  activities.push({
    type: 'REGISTER',
    user: newUser.email,
    timestamp: new Date()
  });
  
  // Send welcome email
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Welcome to Last Stop Shopping!',
    html: `<h2>Welcome to Last Stop Shopping, ${name}!</h2>
           <p>Thank you for registering with us.</p>
           <p>Start exploring our products and enjoy shopping!</p>`
  };
  
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log('Error sending email:', error);
    } else {
      console.log('Email sent:', info.response);
    }
  });
  
  res.json({ 
    message: 'Registration successful', 
    user: { id: newUser.id, name: newUser.name, email: newUser.email } 
  });
});

// User login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  
  // Find user
  const user = users.find(user => user.email === email && user.password === password);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  
  // Log activity
  activities.push({
    type: 'LOGIN',
    user: user.email,
    timestamp: new Date()
  });
  
  res.json({ 
    message: 'Login successful', 
    user: { id: user.id, name: user.name, email: user.email, verified: user.verified } 
  });
});

// Get user activities (for dashboard)
app.get('/api/activities', (req, res) => {
  res.json(activities);
});

// Payment processing endpoint
app.post('/api/process-payment', async (req, res) => {
  try {
    const { method, amount, items, userId } = req.body;

    // Find user to check verification status
    const user = users.find(u => u.id === userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.verified) {
      return res.status(403).json({ error: 'User must be verified to make payments' });
    }

    // For demo purposes, we'll simulate payment processing
    // In production, you would integrate with actual payment processors

    if (method === 'card') {
      // Simulate card payment processing
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        payment_method_types: ['card'],
        metadata: {
          userId: userId,
          items: JSON.stringify(items)
        }
      });

      // Log activity
      activities.push({
        type: 'PAYMENT',
        user: user.email,
        amount: amount,
        method: method,
        timestamp: new Date()
      });

      res.json({
        success: true,
        message: 'Payment processed successfully',
        paymentIntent: paymentIntent
      });

    } else if (method === 'paypal') {
      // Simulate PayPal payment
      activities.push({
        type: 'PAYMENT',
        user: user.email,
        amount: amount,
        method: method,
        timestamp: new Date()
      });

      res.json({
        success: true,
        message: 'PayPal payment initiated successfully'
      });

    } else if (method === 'bank') {
      // Simulate bank transfer
      activities.push({
        type: 'PAYMENT',
        user: user.email,
        amount: amount,
        method: method,
        timestamp: new Date()
      });

      res.json({
        success: true,
        message: 'Bank transfer payment recorded successfully'
      });

    } else {
      res.status(400).json({ error: 'Invalid payment method' });
    }

  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve the main HTML file for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'first.html'));
});

// Create HTTP server and attach Socket.io
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle user joining chat
  socket.on('joinChat', (userData) => {
    const username = userData.name || 'Guest';
    onlineUsers.set(socket.id, { username, userId: userData.userId });

    // Send recent messages to new user
    const recentMessages = chatMessages.slice(-10); // Last 10 messages
    socket.emit('recentMessages', recentMessages);

    // Notify others that user joined
    socket.broadcast.emit('userJoined', { username });

    console.log(`${username} joined the chat`);
  });

  // Handle incoming messages
  socket.on('sendMessage', (data) => {
    const user = onlineUsers.get(socket.id);
    const messageData = {
      id: Date.now(),
      message: data.message,
      sender: user ? user.username : 'Guest',
      userId: user ? user.userId : null,
      timestamp: new Date(),
      socketId: socket.id
    };

    // Store message
    chatMessages.push(messageData);

    // Keep only last 100 messages to prevent memory issues
    if (chatMessages.length > 100) {
      chatMessages = chatMessages.slice(-100);
    }

    // Broadcast message to all connected clients
    io.emit('message', messageData);

    console.log(`Message from ${messageData.sender}: ${messageData.message}`);
  });

  // Handle user disconnecting
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      socket.broadcast.emit('userLeft', { username: user.username });
      onlineUsers.delete(socket.id);
      console.log(`${user.username} left the chat`);
    }
  });

  // Handle typing indicators (optional enhancement)
  socket.on('typing', (data) => {
    socket.broadcast.emit('userTyping', {
      username: data.username,
      isTyping: data.isTyping
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});