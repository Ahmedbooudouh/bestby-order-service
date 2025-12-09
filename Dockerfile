# Use a small Node.js base image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the main server file
COPY server.js ./

# Set environment variables
ENV PORT=4001

# Expose the port used by this service
EXPOSE 4001

# Command to start the service
CMD ["npm", "start"]
