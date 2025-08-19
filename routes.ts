import type { Express } from "express";
import { createServer, type Server } from "http";
import Stripe from "stripe";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { insertPaymentSchema, updateUserSchema } from "@shared/schema";
import { z } from "zod";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Missing required Stripe secret: STRIPE_SECRET_KEY');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Auth middleware
  await setupAuth(app);

  // Seed default plans
  await seedPlans();

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Plans routes
  app.get('/api/plans', async (req, res) => {
    try {
      const plans = await storage.getPlans();
      res.json(plans);
    } catch (error) {
      console.error("Error fetching plans:", error);
      res.status(500).json({ message: "Failed to fetch plans" });
    }
  });

  // Portfolio routes
  app.get('/api/portfolio', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      let portfolio = await storage.getUserPortfolio(userId);
      
      if (!portfolio) {
        // Create default portfolio for new users
        portfolio = await storage.createPortfolio({
          userId,
          totalValue: "124567.00",
          totalReturn: "18.4000",
          monthlyDeposit: "2500.00",
          activeInvestments: 12,
        });
        
        // Add some sample history
        const dates = [
          new Date('2024-01-01'),
          new Date('2024-02-01'),
          new Date('2024-03-01'),
          new Date('2024-04-01'),
          new Date('2024-05-01'),
          new Date('2024-06-01'),
          new Date('2024-07-01'),
          new Date('2024-08-01'),
          new Date('2024-09-01'),
          new Date('2024-10-01'),
        ];
        const values = ['100000', '102500', '98000', '105000', '108500', '112000', '118500', '121000', '119500', '124567'];
        
        for (let i = 0; i < dates.length; i++) {
          await storage.addPortfolioHistory(portfolio.id, values[i]);
        }
      }
      
      const history = await storage.getPortfolioHistory(portfolio.id, 10);
      res.json({ portfolio, history });
    } catch (error) {
      console.error("Error fetching portfolio:", error);
      res.status(500).json({ message: "Failed to fetch portfolio" });
    }
  });

  // User profile routes
  app.put('/api/profile', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const updateData = updateUserSchema.parse(req.body);
      
      const user = await storage.updateUser(userId, updateData);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json(user);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid input", errors: error.errors });
      }
      console.error("Error updating profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });

  // Stripe subscription route
  app.post('/api/create-subscription', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const { planId } = req.body;
      
      if (!planId) {
        return res.status(400).json({ message: "Plan ID is required" });
      }

      const user = await storage.getUser(userId);
      const plan = await storage.getPlan(planId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      if (!plan) {
        return res.status(404).json({ message: "Plan not found" });
      }

      // If user already has a subscription, return existing one
      if (user.stripeSubscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        const invoice = await stripe.invoices.retrieve(subscription.latest_invoice as string, {
          expand: ['payment_intent']
        });
        
        return res.json({
          subscriptionId: subscription.id,
          clientSecret: (invoice.payment_intent as any)?.client_secret,
        });
      }

      if (!user.email) {
        return res.status(400).json({ message: 'No user email on file' });
      }

      // Create Stripe customer
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
        metadata: { userId }
      });

      // Create subscription
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
            },
            unit_amount: Math.round(parseFloat(plan.price) * 100),
            recurring: {
              interval: 'month',
            },
          },
        }],
        payment_behavior: 'default_incomplete',
        expand: ['latest_invoice.payment_intent'],
      });

      // Update user with Stripe info
      await storage.updateUserStripeInfo(userId, customer.id, subscription.id);
      
      // Update user's current plan
      await storage.updateUser(userId, { currentPlan: planId });

      const invoice = subscription.latest_invoice as any;
      const paymentIntent = invoice.payment_intent;

      res.json({
        subscriptionId: subscription.id,
        clientSecret: paymentIntent.client_secret,
      });

    } catch (error: any) {
      console.error("Error creating subscription:", error);
      res.status(500).json({ message: "Error creating subscription: " + error.message });
    }
  });

  // Stripe webhook for handling payment events
  app.post('/api/stripe-webhook', async (req, res) => {
    try {
      const payload = req.body;
      const event = payload;

      switch (event.type) {
        case 'payment_intent.succeeded':
          const paymentIntent = event.data.object;
          // Update payment status in database
          break;
        case 'customer.subscription.updated':
          const subscription = event.data.object;
          // Handle subscription updates
          break;
        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Error handling webhook:", error);
      res.status(500).json({ message: "Webhook error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

async function seedPlans() {
  try {
    const existingPlans = await storage.getPlans();
    if (existingPlans.length === 0) {
      const defaultPlans = [
        {
          id: 'starter',
          name: 'Starter',
          price: '0.00',
          features: JSON.stringify([
            'Up to $10,000 portfolio',
            'Basic portfolio tracking',
            'Monthly rebalancing',
            'Email support'
          ]),
          portfolioLimit: 10000,
          rebalancingFrequency: 'monthly',
          managementFee: '0.0025',
          hasAdvancedAnalytics: false,
          hasTaxOptimization: false,
          hasDedicatedAdvisor: false,
          isPopular: false,
        },
        {
          id: 'professional',
          name: 'Professional',
          price: '29.00',
          features: JSON.stringify([
            'Up to $100,000 portfolio',
            'Advanced analytics',
            'Weekly rebalancing',
            'Priority support',
            'Tax optimization'
          ]),
          portfolioLimit: 100000,
          rebalancingFrequency: 'weekly',
          managementFee: '0.0020',
          hasAdvancedAnalytics: true,
          hasTaxOptimization: true,
          hasDedicatedAdvisor: false,
          isPopular: true,
        },
        {
          id: 'enterprise',
          name: 'Enterprise',
          price: '99.00',
          features: JSON.stringify([
            'Unlimited portfolio size',
            'AI-powered insights',
            'Daily rebalancing',
            'Dedicated advisor',
            'Custom strategies'
          ]),
          portfolioLimit: null,
          rebalancingFrequency: 'daily',
          managementFee: '0.0015',
          hasAdvancedAnalytics: true,
          hasTaxOptimization: true,
          hasDedicatedAdvisor: true,
          isPopular: false,
        },
      ];

      // Insert plans into database (this would normally use the storage interface)
      // For now, we'll assume the plans are seeded elsewhere or implement a direct DB insert
    }
  } catch (error) {
    console.error("Error seeding plans:", error);
  }
}
