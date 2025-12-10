// server.js - Order Service for BestBuy Application
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const { ServiceBusClient } = require("@azure/service-bus");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 4001;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/bestbuy";
app.use(cors());
app.use(express.json());

// ----- Connect to MongoDB -----
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("[Order-Service] Connected to MongoDB");
  })
  .catch((err) => {
    console.error("[Order-Service] MongoDB connection error:", err);
  });
// ---------- Azure Service Bus setup ---------- //
const sbConnectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
const sbQueueName = process.env.SERVICE_BUS_QUEUE_NAME;
let sbClient = null;
let sbSender = null;
// Initialize Service Bus client & sender
async function initServiceBus() {
  try {
    if (!sbConnectionString || !sbQueueName) {
      console.warn(
        "[ServiceBus] Missing SERVICE_BUS_CONNECTION_STRING or SERVICE_BUS_QUEUE_NAME. " +
          "OrderCreated messages will NOT be sent."
      );
      return;
    }

    sbClient = new ServiceBusClient(sbConnectionString);
    sbSender = sbClient.createSender(sbQueueName);

    console.log("[ServiceBus] Connected and sender created for queue:", sbQueueName);
  } catch (err) {
    console.error("[ServiceBus] Failed to initialize:", err.message);
  }
}

// Call initialization when the app starts
initServiceBus();

// Function to send OrderCreated message

async function sendOrderCreatedMessage(order) {
  try {
    if (!sbSender) {
      console.warn("[ServiceBus] Sender is not initialized. Skipping message send.");
      return;
    }

    const payload = {
      orderId: order._id,
      customerEmail: order.customerEmail || null,
      items: order.items || [],
      totalAmount: order.totalAmount || 0,
      status: order.status,
      createdAt: order.createdAt || new Date().toISOString(),
    };

    await sbSender.sendMessages({
      body: payload,
      contentType: "application/json",
    });

    console.log("[ServiceBus] OrderCreated message sent for order:", order._id.toString());
  } catch (err) {
    console.error("[ServiceBus] Failed to send OrderCreated message:", err.message);
  }
}


// ----- Mongoose models -----
// Product model (from product-service)
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    category: { type: String },
    price: { type: Number, required: true },
    stock: { type: Number, required: true, default: 0 },
  },
  { collection: "products" }
);

const Product = mongoose.model("Product", productSchema);

// OrderItem sub-schema

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true }, 
    price: { type: Number, required: true }, 
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

// Order schema

const orderSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    totalAmount: { type: Number, required: true },
    // createdAt will be auto-managed by mongoose
  },
  {
    timestamps: true,
  }
);

const Order = mongoose.model("Order", orderSchema);
// ----- API Endpoints -----

app.post("/api/orders", async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "Order must contain at least one item." });
    }

// Validate items and calculate total
    const orderItems = [];
    let totalAmount = 0;

    for (const item of items) {
      const { productId, quantity } = item;

      if (!productId || !quantity || quantity <= 0) {
        return res
          .status(400)
          .json({ error: "Each item needs productId and positive quantity." });
      }

      const product = await Product.findById(productId);

      if (!product) {
        return res
          .status(400)
          .json({ error: `Product not found: ${productId}` });
      }

      if (product.stock < quantity) {
        return res.status(400).json({
          error: `Not enough stock for product: ${product.name}`,
        });
      }

      const lineTotal = product.price * quantity;
      totalAmount += lineTotal;

      orderItems.push({
        productId: product._id,
        name: product.name,
        price: product.price,
        quantity,
      });
    }

    // Create order document
    const newOrder = new Order({
      status: "PENDING",
      items: orderItems,
      totalAmount,
    });

    const savedOrder = await newOrder.save();
    // Send OrderCreated message to Service Bus
     sendOrderCreatedMessage(savedOrder).catch((err) => {
      console.error(
        "[ServiceBus] Error in sendOrderCreatedMessage:",
        err.message
      );
    });

    

    // Decrease stock for each product
    for (const item of orderItems) {
      await Product.updateOne(
        { _id: item.productId },
        { $inc: { stock: -item.quantity } }
      );
    }

    res.status(201).json(savedOrder);
  } catch (err) {
    console.error("[Order-Service] Error creating order:", err);
    res.status(500).json({ error: "Failed to create order." });
  }
});
// ----- GET /api/orders  (list orders) -----

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(50);
    res.json(orders);
  } catch (err) {
    console.error("[Order-Service] Error fetching orders:", err);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

// ----- GET /api/orders/:id  (get single order) -----

app.get("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }
    res.json(order);
  } catch (err) {
    console.error("[Order-Service] Error fetching order:", err);
    res.status(500).json({ error: "Failed to fetch order." });
  }
});

// ----- PATCH /api/orders/:id  (update status) -----

app.patch("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["PENDING", "COMPLETED", "CANCELLED"];

  if (!status || !allowedStatuses.includes(status.toUpperCase())) {
    return res.status(400).json({
      error:
        "Invalid status. Allowed values: PENDING, COMPLETED, CANCELLED.",
    });
  }

  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { status: status.toUpperCase() },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ error: "Order not found." });
    }

    res.json(updatedOrder);
  } catch (err) {
    console.error("[Order-Service] Error updating order:", err);
    res.status(500).json({ error: "Failed to update order." });
  }
});

// ----- Start server -----

app.listen(PORT, () => {
  console.log(`[Order-Service] Listening on port ${PORT}`);
});
