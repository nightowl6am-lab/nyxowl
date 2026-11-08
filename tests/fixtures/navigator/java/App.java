package com.example;

public interface Greeter {
    String greet(String name);
}

public enum Color {
    RED,
    GREEN,
}

public record Point(int x, int y) {
    public int sum() {
        return x + y;
    }
}

public class App implements Greeter {
    private int count;

    public App(int count) {
        this.count = count;
    }

    @Override
    public String greet(String name) {
        return "hi " + name;
    }

    protected void helper() {
    }

    private void hidden() {
    }

    public static class Inner {
        public void run() {
        }
    }
}
