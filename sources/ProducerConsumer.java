class Producer implements Runnable {
    private final PC pc;
    public Producer(PC pc) {
        this.pc = pc;
    }
    public void run() {
        try {
            pc.produce();
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
    }
}

class Consumer implements Runnable {
    private final PC pc;
    public Consumer(PC pc) {
        this.pc = pc;
    }
    public void run() {
        try {
            pc.consume();
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
    }
}

class PC {
    private final java.util.LinkedList<Integer> list = new java.util.LinkedList<>();
    private final int capacity = 2;

    public void produce() throws InterruptedException {
        int value = 0;
        while (value < 5) {
            synchronized (this) {
                while (list.size() == capacity)
                    wait();
                System.out.println("Producer produced-" + value);
                list.add(value++);
                notify();
                Thread.sleep(100);
            }
        }
    }

    public void consume() throws InterruptedException {
        int i = 0;
        while (i < 5) {
            synchronized (this) {
                while (list.size() == 0)
                    wait();
                int val = list.removeFirst();
                System.out.println("Consumer consumed-" + val);
                i++;
                notify();
                Thread.sleep(100);
            }
        }
    }
}

public class ProducerConsumer {
    public static void main(String[] args) throws InterruptedException {
        PC pc = new PC();
        Thread t1 = new Thread(new Producer(pc));
        Thread t2 = new Thread(new Consumer(pc));
        t1.start();
        t2.start();
        t1.join();
        t2.join();
    }
}
