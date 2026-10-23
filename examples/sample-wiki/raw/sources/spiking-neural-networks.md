---
title: Spiking Neural Networks
domain: ai/architecture
source_kind: article
---
# Spiking Neural Networks

A spiking neural network is a kind of artificial neural network that copies one feature of biological nerve cells: they communicate with short, sharp pulses called spikes. The idea comes from neuroscience. It is an alternative to the networks used in most machine learning today, which pass smooth numbers from layer to layer.

## How a neuron works

Each artificial neuron keeps an internal value, often called its membrane potential. Incoming spikes raise this value. With no input, the value slowly leaks back toward its resting level. When the value crosses a threshold, the neuron fires its own spike and then resets. The spike travels to the neurons it connects to, and the process repeats. The timing of spikes can carry information, as well as the number of spikes in a given window.

## Computing on events

A spiking network is event-driven. A neuron does work only when a spike reaches it or when it fires. If nothing happens at the input, nothing is computed. A conventional network, by contrast, multiplies and adds every value in every layer for every input, whether or not the value matters.

In a typical spiking network, only a small share of the neurons is active at any moment. This sparse activity means that far fewer operations are needed. On hardware built for spikes, which stores state next to the neurons and sends small messages only when a spike occurs, this can save a large amount of energy. The gain is greatest for inputs that change rarely or that arrive as sparse events, such as the output of an event camera.

## Difficulties

Training is the main obstacle. Most modern networks learn by gradient descent, which needs a smooth relationship between a weight and the final error. A spike is an all-or-nothing event, so its derivative is zero almost everywhere and undefined at the threshold. Standard back-propagation therefore does not work directly.

Researchers use several workarounds. One is the surrogate gradient, which replaces the sharp threshold with a smooth stand-in during the backward pass. Another is to train a conventional network first and convert it into a spiking one. A third is to use local learning rules, inspired by biology, in which a connection changes according to the timing of the spikes on either side of it.

Because of these limits, spiking networks currently lag behind conventional networks on many common benchmarks. Their appeal lies in low-power devices and in tasks that depend on timing.
